/* eslint-disable canonical/id-match */

import {
  BackendTerminatedError,
  CheckIntegrityConstraintViolationError,
  ForeignKeyIntegrityConstraintViolationError,
  InputSyntaxError,
  InvalidInputError,
  NotNullIntegrityConstraintViolationError,
  StatementCancelledError,
  StatementTimeoutError,
  UniqueIntegrityConstraintViolationError,
} from '../errors';
import {
  type ClientConfiguration,
  type Field,
  type PrimitiveValueExpression,
  type Query,
  type TypeParser,
} from '../types';
import { parseDsn } from '../utilities/parseDsn';
import { createDriver, type DriverCommand } from './createDriver';
import { Transform } from 'node:stream';
// eslint-disable-next-line no-restricted-imports
import {
  Client,
  type ClientConfig as NativePostgresClientConfiguration,
  type DatabaseError,
} from 'pg';
import QueryStream from 'pg-query-stream';
import { getTypeParser as getNativeTypeParser } from 'pg-types';
import { parse as parseArray } from 'postgres-array';

type PostgresType = {
  oid: string;
  typarray: string;
  typname: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TypeOverrides = (oid: number) => any;

const createTypeOverrides = async (
  connection: Client,
  typeParsers: readonly TypeParser[],
): Promise<TypeOverrides> => {
  const typeNames = typeParsers.map((typeParser) => {
    return typeParser.name;
  });

  const postgresTypes = (
    await connection.query(
      `
        SELECT
          oid,
          typarray,
          typname
        FROM pg_type
        WHERE typname = ANY($1::text[])
      `,
      [typeNames],
    )
  ).rows as PostgresType[];

  const parsers = {};

  for (const typeParser of typeParsers) {
    const postgresType = postgresTypes.find((maybeTargetPostgresType) => {
      return maybeTargetPostgresType.typname === typeParser.name;
    });

    if (!postgresType) {
      throw new Error('Database type "' + typeParser.name + '" not found.');
    }

    parsers[postgresType.oid] = (value) => {
      return typeParser.parse(value);
    };

    if (postgresType.typarray) {
      parsers[postgresType.typarray] = (arrayValue) => {
        return parseArray(arrayValue).map((value) => {
          return typeParser.parse(value);
        });
      };
    }
  }

  return (oid: number) => {
    if (parsers[oid]) {
      return parsers[oid];
    }

    return getNativeTypeParser(oid);
  };
};

const createClientConfiguration = (
  clientConfiguration: ClientConfiguration,
): NativePostgresClientConfiguration => {
  const connectionOptions = parseDsn(clientConfiguration.connectionUri);

  const poolConfiguration: NativePostgresClientConfiguration = {
    application_name: connectionOptions.applicationName,
    database: connectionOptions.databaseName,
    host: connectionOptions.host,
    options: connectionOptions.options,
    password: connectionOptions.password,
    port: connectionOptions.port,
    ssl: false,
    user: connectionOptions.username,
  };

  if (clientConfiguration.ssl) {
    poolConfiguration.ssl = clientConfiguration.ssl;
  } else if (connectionOptions.sslMode === 'disable') {
    poolConfiguration.ssl = false;
  } else if (connectionOptions.sslMode === 'require') {
    poolConfiguration.ssl = true;
  } else if (connectionOptions.sslMode === 'no-verify') {
    poolConfiguration.ssl = {
      rejectUnauthorized: false,
    };
  }

  if (clientConfiguration.connectionTimeout !== 'DISABLE_TIMEOUT') {
    if (clientConfiguration.connectionTimeout === 0) {
      poolConfiguration.connectionTimeoutMillis = 1;
    } else {
      poolConfiguration.connectionTimeoutMillis =
        clientConfiguration.connectionTimeout;
    }
  }

  if (clientConfiguration.statementTimeout !== 'DISABLE_TIMEOUT') {
    if (clientConfiguration.statementTimeout === 0) {
      poolConfiguration.statement_timeout = 1;
    } else {
      poolConfiguration.statement_timeout =
        clientConfiguration.statementTimeout;
    }
  }

  if (
    clientConfiguration.idleInTransactionSessionTimeout !== 'DISABLE_TIMEOUT'
  ) {
    if (clientConfiguration.idleInTransactionSessionTimeout === 0) {
      poolConfiguration.idle_in_transaction_session_timeout = 1;
    } else {
      poolConfiguration.idle_in_transaction_session_timeout =
        clientConfiguration.idleInTransactionSessionTimeout;
    }
  }

  return poolConfiguration;
};

const queryTypeOverrides = async (
  pgClientConfiguration: NativePostgresClientConfiguration,
  clientConfiguration: ClientConfiguration,
): Promise<TypeOverrides> => {
  const client = new Client(pgClientConfiguration);

  await client.connect();

  const typeOverrides = await createTypeOverrides(
    client,
    clientConfiguration.typeParsers,
  );

  await client.end();

  return typeOverrides;
};

const isErrorWithCode = (error: Error): error is DatabaseError => {
  return 'code' in error;
};

const wrapError = (error: Error, query: Query) => {
  if (!isErrorWithCode(error)) {
    return error;
  }

  if (error.code === '22P02') {
    return new InvalidInputError(error.message);
  }

  if (error.code === '57P01') {
    return new BackendTerminatedError(error);
  }

  if (
    error.code === '57014' &&
    // The code alone is not enough to distinguish between a statement timeout and a statement cancellation.
    error.message.includes('canceling statement due to user request')
  ) {
    return new StatementCancelledError(error);
  }

  if (error.code === '57014') {
    return new StatementTimeoutError(error);
  }

  if (error.code === '23502') {
    return new NotNullIntegrityConstraintViolationError(error);
  }

  if (error.code === '23503') {
    return new ForeignKeyIntegrityConstraintViolationError(error);
  }

  if (error.code === '23505') {
    return new UniqueIntegrityConstraintViolationError(error);
  }

  if (error.code === '23514') {
    return new CheckIntegrityConstraintViolationError(error);
  }

  if (error.code === '42601') {
    return new InputSyntaxError(error, query);
  }

  return error;
};

export const createPgDriver = () => {
  let getTypeParserPromise: Promise<TypeOverrides> | null = null;

  return createDriver(async ({ clientConfiguration, eventEmitter }) => {
    const pgClientConfiguration =
      createClientConfiguration(clientConfiguration);

    if (!getTypeParserPromise) {
      getTypeParserPromise = queryTypeOverrides(
        pgClientConfiguration,
        clientConfiguration,
      );
    }

    // eslint-disable-next-line require-atomic-updates
    pgClientConfiguration.types = {
      getTypeParser: await getTypeParserPromise,
    };

    const onNotice = (notice) => {
      if (notice.message) {
        eventEmitter.emit('notice', {
          message: notice.message,
        });
      }
    };

    return () => {
      const client = new Client(pgClientConfiguration);

      client.on('notice', onNotice);

      return {
        connect: async () => {
          await client.connect();
        },
        end: async () => {
          await client.end();
          client.removeListener('notice', onNotice);
        },
        query: async (sql, values) => {
          let result;

          try {
            result = await client.query(sql, values as unknown[]);
          } catch (error) {
            throw wrapError(error, {
              sql,
              values: values as readonly PrimitiveValueExpression[],
            });
          }

          return {
            command: result.command as DriverCommand,
            fields: result.fields.map((field) => {
              return {
                dataTypeId: field.dataTypeID,
                name: field.name,
              };
            }),
            rowCount: result.rowCount,
            rows: result.rows,
          };
        },
        stream: (sql, values) => {
          const stream = client.query(
            new QueryStream(sql, values as unknown[]),
          );

          let fields: readonly Field[] = [];

          // `rowDescription` will not fire if the query produces a syntax error.
          // Also, `rowDescription` won't fire until client starts consuming the stream.
          // This is why we cannot simply await for `rowDescription` event before starting to pipe the stream.
          // @ts-expect-error – https://github.com/brianc/node-postgres/issues/3015
          client.connection.once('rowDescription', (rowDescription) => {
            fields = rowDescription.fields.map((field) => {
              return {
                dataTypeId: field.dataTypeID,
                name: field.name,
              };
            });
          });

          const transform = new Transform({
            objectMode: true,
            async transform(datum, enc, callback) {
              if (!fields) {
                callback(new Error('Fields not available'));

                return;
              }

              // eslint-disable-next-line @babel/no-invalid-this
              this.push({
                fields,
                row: datum,
              });

              callback();
            },
          });

          stream.on('error', (error) => {
            transform.emit(
              'error',
              wrapError(error, {
                sql,
                values: values as PrimitiveValueExpression[],
              }),
            );
          });

          return stream.pipe(transform);
        },
      };
    };
  });
};
