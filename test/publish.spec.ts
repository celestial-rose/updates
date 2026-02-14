import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAppJsonPath, getJurisdiction, stripJsonComments } from '../scripts/publish';
import { resolve, join } from 'path';

// Mock dependencies
vi.mock('child_process', () => ({
    execSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        existsSync: vi.fn(),
        readFileSync: vi.fn(),
        appendFileSync: vi.fn(),
        mkdirSync: vi.fn(),
    };
});

vi.mock('readline', () => ({
    createInterface: vi.fn(() => ({
        question: vi.fn((q, cb) => cb('')),
        close: vi.fn(),
    })),
}));

// We need to properly mock console.log to avoid noise and check outputs
const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

// Import mocked modules for assertions
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { createInterface } from 'readline';

describe('getAppJsonPath', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        vi.clearAllMocks();
        // Default existsSync behavior
        (existsSync as any).mockReturnValue(true);
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('returns path from APP_JSON_PATH env if set', async () => {
        process.env.APP_JSON_PATH = '../test-app/app.json';
        const path = await getAppJsonPath();
        expect(path).toBe(resolve('../test-app/app.json'));
    });

    it('returns path from EXPO_PROJECT_PATHS if single path set', async () => {
        delete process.env.APP_JSON_PATH;
        process.env.EXPO_PROJECT_PATHS = '/abs/path/to/project';
        
        const path = await getAppJsonPath();
        expect(path).toBe(join('/abs/path/to/project', 'app.json'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Using configured project'));
    });

    it('prompts user if multiple EXPO_PROJECT_PATHS are set', async () => {
        delete process.env.APP_JSON_PATH;
        process.env.EXPO_PROJECT_PATHS = '/path/A, /path/B';
        
        // Mock user selecting option 2
        (createInterface as any).mockReturnValue({
            question: vi.fn((q, cb) => {
                if (q.includes('Select an option')) {
                    cb('2'); // Select /path/B
                }
            }),
            close: vi.fn(),
        });

        const path = await getAppJsonPath();
        expect(path).toBe(join('/path/B', 'app.json'));
    });

    it('prompts user for path if no ENV vars set', async () => {
        delete process.env.APP_JSON_PATH;
        delete process.env.EXPO_PROJECT_PATHS;

        // Mock user entering path
        (createInterface as any).mockReturnValue({
            question: vi.fn((q, cb) => {
                if (q.includes('Enter the absolute path')) {
                    cb('/manual/path');
                } else if (q.includes('save this path')) {
                    cb('n'); // Don't save
                }
            }),
            close: vi.fn(),
        });

        const path = await getAppJsonPath();
        expect(path).toBe(join(resolve('/manual/path'), 'app.json'));
    });

    it('saves path to .env if user accepts', async () => {
        delete process.env.APP_JSON_PATH;
        delete process.env.EXPO_PROJECT_PATHS;

        // Mock user entering path and saving
        (createInterface as any).mockReturnValue({
            question: vi.fn((q, cb) => {
                if (q.includes('Enter the absolute path')) {
                    cb('/manual/path/save');
                } else if (q.includes('save this path')) {
                    cb('y'); // Save
                }
            }),
            close: vi.fn(),
        });

        // Mock .env reading
        (readFileSync as any).mockReturnValue('EXISTING_VAR=1');

        await getAppJsonPath();

        expect(appendFileSync).toHaveBeenCalledWith(
            expect.stringContaining('.env'),
            expect.stringContaining('EXPO_PROJECT_PATHS=')
        );
        expect(appendFileSync).toHaveBeenCalledWith(
            expect.stringContaining('.env'),
            expect.stringContaining('/manual/path/save')
        );
    });
});

describe('stripJsonComments', () => {
    it('removes single line comments', () => {
        expect(stripJsonComments('{ "a": 1 // comment \n}')).toBe('{ "a": 1  \n}');
    });
    it('removes block comments', () => {
        expect(stripJsonComments('{ "a": 1 /* comment */ }')).toBe('{ "a": 1  }');
    });
});

describe('getJurisdiction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (existsSync as any).mockReturnValue(true);
    });

    it('returns undefined if wrangler.jsonc does not exist', () => {
        (existsSync as any).mockReturnValue(false);
        expect(getJurisdiction('/root', 'bucket')).toBeUndefined();
    });

    it('returns jurisdiction from correct env', () => {
        const json = `{
            "env": {
                "production": {
                    "r2_buckets": [
                        { "bucket_name": "prod-bucket", "jurisdiction": "eu" }
                    ]
                }
            }
        }`;
        (readFileSync as any).mockReturnValue(json);
        
        expect(getJurisdiction('/root', 'prod-bucket', 'production')).toBe('eu');
    });

    it('returns undefined if bucket not found', () => {
        const json = `{ "r2_buckets": [] }`;
        (readFileSync as any).mockReturnValue(json);
        expect(getJurisdiction('/root', 'missing')).toBeUndefined();
    });
    
    it('strips comments before parsing', () => {
        const json = `{
            // comment
            "r2_buckets": [
                { "bucket_name": "bucket", "jurisdiction": "us" }
            ]
        }`;
        (readFileSync as any).mockReturnValue(json);
        expect(getJurisdiction('/root', 'bucket')).toBe('us');
    });
});