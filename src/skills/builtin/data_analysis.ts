/**
 * TITAN — Data Analysis Skill (Built-in)
 * Pure TypeScript CSV parsing and statistical analysis.
 * No external dependencies — read files and compute stats natively.
 */
import { registerSkill } from '../registry.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

interface ParsedCSV {
    headers: string[];
    rows: Record<string, string>[];
}

interface ColumnStats {
    count: number;
    unique?: number;
    sum?: number;
    avg?: number;
    min?: number;
    max?: number;
    stddev?: number;
}

/**
 * Parse CSV content handling quoted fields with embedded delimiters
 */
function parseCSV(content: string, delimiter: string = ','): ParsedCSV {
    const lines: string[] = [];
    let current = '';
    let inQuotes = false;

    // Split by line while respecting quoted fields
    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        const nextChar = content[i + 1];

        if (char === '"') {
            // Handle escaped quotes
            if (inQuotes && nextChar === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
            if (current.trim()) {
                lines.push(current);
            }
            current = '';
            // Skip \r\n
            if (char === '\r' && nextChar === '\n') {
                i++;
            }
        } else {
            current += char;
        }
    }
    if (current.trim()) {
        lines.push(current);
    }

    if (lines.length === 0) {
        return { headers: [], rows: [] };
    }

    // Parse header
    const headers = parseCSVLine(lines[0], delimiter);

    // Parse rows
    const rows: Record<string, string>[] = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i], delimiter);
        const row: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = values[j] || '';
        }
        rows.push(row);
    }

    return { headers, rows };
}

/**
 * Parse a single CSV line respecting quoted fields
 */
function parseCSVLine(line: string, delimiter: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];

        if (char === '"') {
            // Handle escaped quotes
            if (inQuotes && nextChar === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === delimiter && !inQuotes) {
            fields.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    fields.push(current.trim());

    return fields;
}

/**
 * Check if a value is numeric
 */
function isNumeric(value: string): boolean {
    const num = Number(value);
    return !isNaN(num) && value.trim() !== '';
}

/**
 * Calculate statistics for numeric columns
 */
function calculateNumericStats(values: number[]): Partial<ColumnStats> {
    if (values.length === 0) {
        return {};
    }

    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);

    // Calculate standard deviation
    const variance =
        values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / values.length;
    const stddev = Math.sqrt(variance);

    return {
        count: values.length,
        sum: Math.round(sum * 100) / 100,
        avg: Math.round(avg * 100) / 100,
        min: Math.round(min * 100) / 100,
        max: Math.round(max * 100) / 100,
        stddev: Math.round(stddev * 100) / 100,
    };
}

/**
 * Format stats table for display
 */
function formatStatsTable(stats: Record<string, ColumnStats>): string {
    const lines: string[] = [];
    lines.push('Column Statistics:\n');

    for (const [col, stat] of Object.entries(stats)) {
        lines.push(`${col}:`);
        if (stat.count !== undefined) lines.push(`  Count: ${stat.count}`);
        if (stat.unique !== undefined) lines.push(`  Unique: ${stat.unique}`);
        if (stat.sum !== undefined) lines.push(`  Sum: ${stat.sum}`);
        if (stat.avg !== undefined) lines.push(`  Average: ${stat.avg}`);
        if (stat.min !== undefined) lines.push(`  Min: ${stat.min}`);
        if (stat.max !== undefined) lines.push(`  Max: ${stat.max}`);
        if (stat.stddev !== undefined) lines.push(`  Std Dev: ${stat.stddev}`);
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Format rows as a table
 */
function formatTable(headers: string[], rows: Record<string, string>[]): string {
    if (rows.length === 0) {
        return 'No rows to display.';
    }

    // Calculate column widths
    const widths: Record<string, number> = {};
    for (const header of headers) {
        widths[header] = header.length;
    }
    for (const row of rows) {
        for (const header of headers) {
            widths[header] = Math.max(widths[header], String(row[header] || '').length);
        }
    }

    // Build table
    const lines: string[] = [];

    // Header
    const headerRow = headers
        .map(h => h.padEnd(widths[h]))
        .join(' | ');
    lines.push(headerRow);
    lines.push('-'.repeat(headerRow.length));

    // Rows
    for (const row of rows) {
        const dataRow = headers
            .map(h => String(row[h] || '').padEnd(widths[h]))
            .join(' | ');
        lines.push(dataRow);
    }

    return lines.join('\n');
}

export function registerDataAnalysisSkill(): void {
    registerSkill(
        {
            name: 'data_analysis',
            description: 'Use this when the user says "analyze this data", "what does this CSV say", "parse this file", "look at this dataset", "show me the data", or shares a CSV file they want read and displayed.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'csv_parse',
            description: 'Read and display the contents of a CSV file. Use this when the user says "open this CSV", "show me what\'s in this file", "read this dataset", "what does this CSV contain", or shares a spreadsheet path they want viewed. Returns the data as a formatted table.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Path to the CSV file',
                    },
                    delimiter: {
                        type: 'string',
                        description: 'Field delimiter (default: comma)',
                    },
                    maxRows: {
                        type: 'number',
                        description: 'Maximum rows to return (default: 1000)',
                    },
                },
                required: ['path'],
            },
            execute: async (args) => {
                try {
                    const path = args.path as string;
                    const delimiter = (args.delimiter as string) || ',';
                    const maxRows = Math.min((args.maxRows as number) || 1000, 5000);

                    const filePath = resolve(path);
                    const content = readFileSync(filePath, 'utf-8');
                    const { headers, rows } = parseCSV(content, delimiter);

                    const displayRows = rows.slice(0, maxRows);
                    const summary = `Parsed ${rows.length} rows, showing first ${displayRows.length}.\n\n`;

                    return summary + formatTable(headers, displayRows);
                } catch (e) {
                    return `Error parsing CSV: ${(e as Error).message}`;
                }
            },
        }
    );

    registerSkill(
        {
            name: 'data_analysis',
            description: 'Use this when the user says "analyze this data", "find patterns in X", "summarize this dataset", "what are the stats on this?", "give me the numbers on this CSV", or asks for statistical insight into tabular data.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'csv_stats',
            description: 'Compute statistics on a CSV file — counts, sums, averages, min/max, and standard deviation. Use when asked to "analyze this data", "find patterns in X", "summarize this dataset", "what are the stats?", "give me the numbers on this CSV", or "how does column Y look?".',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Path to the CSV file',
                    },
                    columns: {
                        type: 'string',
                        description: 'Comma-separated column names to analyze (optional — all columns if not specified)',
                    },
                    delimiter: {
                        type: 'string',
                        description: 'Field delimiter (default: comma)',
                    },
                },
                required: ['path'],
            },
            execute: async (args) => {
                try {
                    const path = args.path as string;
                    const columnsArg = (args.columns as string) || '';
                    const delimiter = (args.delimiter as string) || ',';

                    const filePath = resolve(path);
                    const content = readFileSync(filePath, 'utf-8');
                    const { headers, rows } = parseCSV(content, delimiter);

                    const selectedColumns = columnsArg
                        ? columnsArg.split(',').map(c => c.trim())
                        : headers;

                    const stats: Record<string, ColumnStats> = {};

                    for (const col of selectedColumns) {
                        if (!headers.includes(col)) continue;

                        const values = rows.map(r => r[col] || '');
                        const numericValues = values.filter(isNumeric).map(Number);

                        if (numericValues.length > 0) {
                            // Numeric column
                            stats[col] = calculateNumericStats(numericValues) as ColumnStats;
                        } else {
                            // String column - count unique
                            const unique = new Set(values.filter(v => v.trim())).size;
                            stats[col] = {
                                count: values.length,
                                unique,
                            };
                        }
                    }

                    return formatStatsTable(stats);
                } catch (e) {
                    return `Error calculating CSV stats: ${(e as Error).message}`;
                }
            },
        }
    );

    registerSkill(
        {
            name: 'data_analysis',
            description: 'Use this when the user says "filter this data", "show me rows where X", "find entries matching Y", "sort by Z", or wants to query/slice a CSV dataset.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'csv_query',
            description: 'Filter, sort, and slice a CSV dataset with simple expressions. Use when asked to "show me rows where X > 30", "find all entries where status is active", "sort by date", "filter this data by Y", or "which rows match Z". Supports expressions like "age > 30", "name contains john", "status == active".',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Path to the CSV file',
                    },
                    filter: {
                        type: 'string',
                        description: 'Filter expression (e.g., "age > 30", "name contains john", "status == active")',
                    },
                    sort: {
                        type: 'string',
                        description: 'Column name to sort results by (optional)',
                    },
                    limit: {
                        type: 'number',
                        description: 'Maximum rows to return (default: 50)',
                    },
                    columns: {
                        type: 'string',
                        description: 'Comma-separated columns to include in results (optional — all if not specified)',
                    },
                    delimiter: {
                        type: 'string',
                        description: 'Field delimiter (default: comma)',
                    },
                },
                required: ['path'],
            },
            execute: async (args) => {
                try {
                    const path = args.path as string;
                    const filter = (args.filter as string) || '';
                    const sort = (args.sort as string) || '';
                    const limit = Math.min((args.limit as number) || 50, 1000);
                    const columnsArg = (args.columns as string) || '';
                    const delimiter = (args.delimiter as string) || ',';

                    const filePath = resolve(path);
                    const content = readFileSync(filePath, 'utf-8');
                    const parsed = parseCSV(content, delimiter);
                    const { headers } = parsed;
                    let { rows } = parsed;

                    // Apply filter
                    if (filter) {
                        const [column, expression] = filter.split(/\s*(>|<|>=|<=|==|!=|contains)\s*/);
                        const cleanColumn = column.trim();
                        const op = expression || '';
                        const value = filter.substring(filter.indexOf(op) + op.length).trim();

                        rows = rows.filter(row => {
                            const cellValue = row[cleanColumn] || '';
                            const expr = `${cellValue} ${op} ${value}`;
                            return evaluateExpression(expr, cellValue);
                        });
                    }

                    // Apply sort
                    if (sort && headers.includes(sort)) {
                        rows.sort((a, b) => {
                            const aVal = a[sort] || '';
                            const bVal = b[sort] || '';
                            const aNum = Number(aVal);
                            const bNum = Number(bVal);
                            if (!isNaN(aNum) && !isNaN(bNum)) {
                                return aNum - bNum;
                            }
                            return aVal.localeCompare(bVal);
                        });
                    }

                    // Apply column selection
                    const displayHeaders = columnsArg ? columnsArg.split(',').map(c => c.trim()) : headers;
                    const displayRows = rows.slice(0, limit).map(row => {
                        const newRow: Record<string, string> = {};
                        for (const col of displayHeaders) {
                            newRow[col] = row[col] || '';
                        }
                        return newRow;
                    });

                    const summary = `Filtered to ${rows.length} rows, displaying first ${displayRows.length}.\n\n`;
                    return summary + formatTable(displayHeaders, displayRows);
                } catch (e) {
                    return `Error querying CSV: ${(e as Error).message}`;
                }
            },
        }
    );
}

/**
 * Evaluate a filter expression
 */
function evaluateExpression(expr: string, _cellValue: string): boolean {
    const operators = ['>=', '<=', '!=', '==', '>', '<', 'contains'];
    for (const op of operators) {
        if (expr.includes(op)) {
            const parts = expr.split(op).map(s => s.trim());
            if (parts.length < 2) continue;

            const leftVal = parts[0];
            const rightVal = parts.slice(1).join(op).trim().replace(/^['"]|['"]$/g, '');

            switch (op) {
                case '>':
                    return Number(leftVal) > Number(rightVal);
                case '<':
                    return Number(leftVal) < Number(rightVal);
                case '>=':
                    return Number(leftVal) >= Number(rightVal);
                case '<=':
                    return Number(leftVal) <= Number(rightVal);
                case '==':
                    return String(leftVal) === String(rightVal);
                case '!=':
                    return String(leftVal) !== String(rightVal);
                case 'contains':
                    return String(leftVal).toLowerCase().includes(String(rightVal).toLowerCase());
                default:
                    return false;
            }
        }
    }
    return true;
}
