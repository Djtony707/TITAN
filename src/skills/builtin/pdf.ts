/**
 * TITAN — PDF Parsing Skill (Built-in)
 * Extract text and metadata from PDF files.
 * Uses pdf-parse if available, falls back to basic buffer text extraction.
 */
import { existsSync, readFileSync } from 'fs';
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'PDFSkill';

/** Extract text from PDF buffer using basic heuristics */
function extractTextFromBuffer(buffer: Buffer): string {
    try {
        const text = buffer.toString('latin1');

        // Find BT (begin text) and ET (end text) markers and extract text between them
        const textObjects: string[] = [];
        let match;
        const btEtRegex = /BT([\s\S]*?)ET/g;

        while ((match = btEtRegex.exec(text)) !== null) {
            const textContent = match[1];

            // Extract text strings (enclosed in parentheses or angle brackets)
            const strMatches = textContent.match(/\(([^)]*)\)|<([^>]*)>/g);
            if (strMatches) {
                for (const str of strMatches) {
                    // Remove BT/ET markers and parentheses/brackets
                    let cleanStr = str.replace(/[()<>]/g, '');
                    // Decode hex strings
                    cleanStr = cleanStr.replace(/#([0-9A-Fa-f]{2})/g, (_, hex) => {
                        return String.fromCharCode(parseInt(hex, 16));
                    });
                    if (cleanStr.trim()) {
                        textObjects.push(cleanStr);
                    }
                }
            }
        }

        // Join extracted text with newlines
        let extracted = textObjects.join('\n');

        // If no text found via BT/ET, try a simpler approach: look for readable ASCII/Latin1
        if (!extracted || extracted.length < 100) {
            extracted = text.replace(/[^\x20-\x7E\n\r\t]/g, ' ').trim();
        }

        return extracted.substring(0, 50000); // Truncate to 50k chars
    } catch (error) {
        logger.warn(COMPONENT, `Failed to extract text from buffer: ${(error as Error).message}`);
        return '';
    }
}

/** Extract metadata from PDF buffer */
function extractMetadataFromBuffer(buffer: Buffer): { pages: number; author?: string; title?: string } {
    try {
        const text = buffer.toString('latin1');

        // Try to find /Pages and count page objects
        const pagesMatch = text.match(/\/Type\s*\/Pages[\s\S]*?\/Count\s*(\d+)/);
        const pages = pagesMatch ? parseInt(pagesMatch[1], 10) : 0;

        // Try to extract metadata from Info dictionary
        let author: string | undefined;
        let title: string | undefined;

        const infoMatch = text.match(/\/Info\s*(\d+)\s*(\d+)\s*R/);
        if (infoMatch) {
            // Look for Author and Title in the document
            const authorMatch = text.match(/\/Author\s*\(([^)]*)\)/);
            const titleMatch = text.match(/\/Title\s*\(([^)]*)\)/);

            if (authorMatch) author = authorMatch[1];
            if (titleMatch) title = titleMatch[1];
        }

        return { pages, author, title };
    } catch (error) {
        logger.warn(COMPONENT, `Failed to extract metadata: ${(error as Error).message}`);
        return { pages: 0 };
    }
}

/** Attempt to use pdf-parse, fall back to buffer extraction */
async function extractPdfText(filePath: string): Promise<string> {
    try {
        // Try to dynamically import pdf-parse (optional dependency)
        const pdfParseModule = await (Function('return import("pdf-parse")')() as Promise<Record<string, unknown>>);
        const pdfParse = pdfParseModule.default as (buf: Buffer) => Promise<Record<string, unknown>>;
        const buffer = readFileSync(filePath);
        const pdfData = await pdfParse(buffer);

        let fullText = '';
        for (const page of (pdfData.pages as Array<{ text?: string }>) || []) {
            fullText += page.text || '';
            fullText += '\n---PAGE BREAK---\n';
        }

        return fullText.substring(0, 50000); // Truncate to 50k chars
    } catch {
        logger.debug(COMPONENT, 'pdf-parse not available, falling back to buffer extraction');

        // Fallback: extract from buffer
        const buffer = readFileSync(filePath);
        return extractTextFromBuffer(buffer);
    }
}

/** Attempt to extract PDF metadata using pdf-parse or fallback */
async function extractPdfMetadata(
    filePath: string,
): Promise<{ pages: number; author?: string; title?: string }> {
    try {
        // Try to use pdf-parse for metadata (optional dependency)
        const pdfParseModule = await (Function('return import("pdf-parse")')() as Promise<Record<string, unknown>>);
        const pdfParse = pdfParseModule.default as (buf: Buffer) => Promise<Record<string, unknown>>;
        const buffer = readFileSync(filePath);
        const pdfData = await pdfParse(buffer);
        const pdfInfo = pdfData.info as Record<string, unknown> | undefined;

        return {
            pages: (pdfData.numpages as number) || 0,
            author: pdfInfo?.Author as string | undefined,
            title: pdfInfo?.Title as string | undefined,
        };
    } catch {
        logger.debug(COMPONENT, 'pdf-parse not available, falling back to buffer extraction');

        // Fallback: extract from buffer
        const buffer = readFileSync(filePath);
        return extractMetadataFromBuffer(buffer);
    }
}

export function registerPdfSkill(): void {
    // Tool 1: pdf_read
    registerSkill(
        { name: 'pdf_read', description: 'Extract text content from PDF files. USE THIS WHEN Tony says: "read this PDF", "extract text from PDF", "summarize this PDF", "what does this PDF say", "parse PDF at path X". Works on local file paths. RULES: Use the absolute file path.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'pdf_read',
            description: 'Extracts all text content from a PDF file at a local path. USE THIS WHEN Tony says: "read this PDF", "extract text from PDF", "summarize this PDF", "what does this PDF say", "get the text out of file X.pdf". Returns the full text up to 50,000 characters. Page breaks are marked with ---PAGE BREAK---. RULES: Provide an absolute file path. If Tony gives a URL, download the file first.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute file path to the PDF file',
                    },
                },
                required: ['path'],
            },
            execute: async (args: Record<string, unknown>) => {
                const filePath = args.path as string;

                if (!filePath) {
                    return 'Error: path parameter is required';
                }

                try {
                    if (!existsSync(filePath)) {
                        return `Error: PDF file not found at ${filePath}`;
                    }

                    logger.info(COMPONENT, `Extracting text from PDF: ${filePath}`);

                    const text = await extractPdfText(filePath);

                    if (!text || text.trim().length === 0) {
                        return `Warning: No text could be extracted from ${filePath}. The PDF may be scanned images or encrypted.`;
                    }

                    return `# PDF Text Extraction\n\nSource: ${filePath}\n\n${text}`;
                } catch (error) {
                    const msg = (error as Error).message;
                    logger.error(COMPONENT, `PDF text extraction failed: ${msg}`);
                    return `Error extracting text from PDF: ${msg}`;
                }
            },
        },
    );

    // Tool 2: pdf_info
    registerSkill(
        { name: 'pdf_info', description: 'Get PDF metadata (page count, author, title). USE THIS WHEN Tony says: "how many pages is this PDF", "who wrote this PDF", "get PDF info", "PDF metadata".', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'pdf_info',
            description: 'Extracts metadata from a PDF file including page count, author, and title. USE THIS WHEN Tony says: "how many pages is this PDF", "who wrote this PDF", "get PDF info", "PDF metadata for X". RULES: Provide an absolute file path.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute file path to the PDF file',
                    },
                },
                required: ['path'],
            },
            execute: async (args: Record<string, unknown>) => {
                const filePath = args.path as string;

                if (!filePath) {
                    return 'Error: path parameter is required';
                }

                try {
                    if (!existsSync(filePath)) {
                        return `Error: PDF file not found at ${filePath}`;
                    }

                    logger.info(COMPONENT, `Extracting metadata from PDF: ${filePath}`);

                    const metadata = await extractPdfMetadata(filePath);

                    let result = `# PDF Metadata\n\nFile: ${filePath}\n\n`;
                    result += `**Pages**: ${metadata.pages}\n`;

                    if (metadata.title) {
                        result += `**Title**: ${metadata.title}\n`;
                    }

                    if (metadata.author) {
                        result += `**Author**: ${metadata.author}\n`;
                    }

                    if (metadata.pages === 0) {
                        result += `\nWarning: Could not determine page count. The PDF may be corrupted or have an unusual format.`;
                    }

                    return result;
                } catch (error) {
                    const msg = (error as Error).message;
                    logger.error(COMPONENT, `PDF metadata extraction failed: ${msg}`);
                    return `Error extracting metadata from PDF: ${msg}`;
                }
            },
        },
    );
}
