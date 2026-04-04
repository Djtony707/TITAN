/* eslint-disable @typescript-eslint/no-explicit-any */
declare module 'pg' {
    export interface PoolConfig {
        connectionString?: string;
        max?: number;
        idleTimeoutMillis?: number;
        connectionTimeoutMillis?: number;
    }

    export interface QueryResult<T = any> {
        rows: T[];
        rowCount: number | null;
    }

    export interface PoolClient {
        query<T = any>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
        release(err?: boolean | Error): void;
    }

    export class Pool {
        constructor(config?: PoolConfig);
        query<T = any>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
        connect(): Promise<PoolClient>;
        end(): Promise<void>;
        on(event: string, listener: (...args: any[]) => void): this;
    }
}
