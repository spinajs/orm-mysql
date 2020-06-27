import { IColumnDescriptor, QueryContext, OrmDriver, QueryBuilder, TransactionCallback } from '@spinajs/orm';
import * as mysql from 'mysql';
import { SqlDriver } from '@spinajs/orm-sql';
import { Injectable, Container } from '@spinajs/di';

@Injectable('orm-driver-mysql')
export class MysqlOrmDriver extends SqlDriver {
  protected _connectionPool: mysql.Pool;

  public execute(stmt: string, params: any[], queryContext: QueryContext): Promise<any> {
    const queryParams = params ?? [];

    if (!this._connectionPool) {
      throw new Error('cannot execute mysql statement, connection pool not created');
    }

    super.execute(stmt, queryParams, queryContext);

    return new Promise((res, rej) => {
      switch (queryContext) {
        case QueryContext.Update:
        case QueryContext.Delete:
        case QueryContext.Schema:
        case QueryContext.Transaction:
        case QueryContext.Insert:
        case QueryContext.Select:
          this._connectionPool.query(stmt, queryParams, (err: any, result: any, _fields: any) => {
            if (err) {
              rej(err);
              return;
            }

            if (queryContext === QueryContext.Insert) {
              res(result.insertId);
            } else {
              res(result);
            }
          });
          break;
      }
    });
  }

  public async ping(): Promise<boolean> {
    const result = await this.execute('SELECT 1', [], QueryContext.Select);
    return result !== null || result !== undefined;
  }

  public async connect(): Promise<OrmDriver> {
    const { PoolLimit, Host, User, Password, Database, Encoding, Options } = this.Options;

    if (this._connectionPool != null) {
      await this.disconnect();
    }

    this._connectionPool = mysql.createPool({
      connectionLimit: PoolLimit,
      host: Host,
      user: User,
      password: Password,
      database: Database,
      charset: Encoding,
      ...Options,
    });

    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    return new Promise((resolve, reject) => {
      this._connectionPool?.end(err => {
        if (err) {
          reject(err);
        } else {
          this._connectionPool = null;
          resolve(this);
        }
      });
    });
  }

  public async resolve(container: Container) {
    super.resolve(container);

    this.Container = this.Container.child();
  }

  public async transaction(qrOrCallback: QueryBuilder[] | TransactionCallback) {
    if (!qrOrCallback) {
      return;
    }

    await this.execute('START TRANSACTION', null, QueryContext.Transaction);

    try {
      if (Array.isArray(qrOrCallback)) {
        for (const q of qrOrCallback) {
          await q;
        }
      } else {
        await qrOrCallback(this);
      }

      await this.execute('COMMIT', null, QueryContext.Transaction);
    } catch (ex) {
      await this.execute('ROLLBACK', null, QueryContext.Transaction);
      throw ex;
    }
  }

  /**
   *
   * Retrieves information about specific DB table if exists. If table not exists returns null
   *
   * @param name table name to retrieve info
   * @param _schema - optional schema name
   * @returns {[] | null}
   */
  public async tableInfo(tableName: string, _schema?: string): Promise<IColumnDescriptor[]> {
    const tableSchema = _schema ? _schema : this.Options.Database;
    const select = [
      'COLUMN_NAME',
      'TABLE_NAME',
      'DATA_TYPE',
      'CHARACTER_MAXIMUM_LENGTH',
      'COLUMN_COMMENT',
      'COLUMN_DEFAULT',
      'COLUMN_TYPE',
      'IS_NULLABLE',
      'EXTRA',
      'COLUMN_KEY',
    ];

    const tblInfo = (await this.execute(
      `SELECT ${select.join(
        ',',
      )} FROM information_schema.columns  WHERE table_schema = '${tableSchema}' AND TABLE_NAME = '${tableName}'`,
      null,
      QueryContext.Select,
    )) as [];
    const tblIndices = (await this.execute(`SHOW INDEX FROM ${tableName}`, null, QueryContext.Select)) as [];

    return tblInfo.map((r: any) => {
      return {
        Type: r.DATA_TYPE.toLowerCase(),
        MaxLength: r.CHARACTER_MAXIMUM_LENGTH,
        Comment: r.COLUMN_COMMENT,
        DefaultValue: r.COLUMN_DEFAULT,
        NativeType: r.COLUMN_TYPE,
        Unsigned: false,
        Nullable: r.IS_NULLABLE === 'YES',
        PrimaryKey: r.COLUMN_KEY === 'PRI',
        AutoIncrement: r.EXTRA.includes('auto_increment'),
        Name: r.COLUMN_NAME,
        Converter: null,
        Schema: _schema ? _schema : this.Options.Database,
        Unique: tblIndices.find((i: any) => i.Column_name === r.name && i.Non_unique === 0) !== undefined,
        Uuid: false,
      };
    });
  }
}
