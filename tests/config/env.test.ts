/**
 * Focused boundary-case tests for the bounded env parsing helpers in src/config/env.ts.
 *
 * These helpers back the reactive numeric configuration (src/reactive/config.ts) and
 * other runtime config surfaces. C4 requires that every bounded numeric field has a
 * documented, consistent behavior for negative, zero, malformed, overflow, and
 * boundary values:
 *   - malformed (non-numeric / empty / whitespace) input -> falls back to the default
 *   - well-formed but out-of-range input (negative, zero below min, overflow above max)
 *     -> clamped to the nearest bound
 *   - well-formed in-range input (including exact boundary values) -> used as-is
 */
import { describe, it, expect } from '@jest/globals';
import { envBool, envInt, envMs, envString, envCsv, envEnum, envPerfProfile } from '../../src/config/env.js';

const ENV_VAR = 'CE_TEST_ENV_HELPER_VALUE';

function withEnv<T>(value: string | undefined, fn: () => T): T {
    const original = process.env[ENV_VAR];
    if (value === undefined) {
        delete process.env[ENV_VAR];
    } else {
        process.env[ENV_VAR] = value;
    }
    try {
        return fn();
    } finally {
        if (original === undefined) {
            delete process.env[ENV_VAR];
        } else {
            process.env[ENV_VAR] = original;
        }
    }
}

describe('envInt (bounded numeric parsing)', () => {
    describe('unset / malformed input falls back to default', () => {
        it('returns the default when unset', () => {
            withEnv(undefined, () => {
                expect(envInt(ENV_VAR, 42, { min: 0, max: 100 })).toBe(42);
            });
        });

        it('returns the default for a non-numeric string', () => {
            withEnv('not-a-number', () => {
                expect(envInt(ENV_VAR, 42, { min: 0, max: 100 })).toBe(42);
            });
        });

        it('returns the default for an empty string', () => {
            withEnv('', () => {
                expect(envInt(ENV_VAR, 42, { min: 0, max: 100 })).toBe(42);
            });
        });

        it('returns the default for a whitespace-only string', () => {
            withEnv('   ', () => {
                expect(envInt(ENV_VAR, 42, { min: 0, max: 100 })).toBe(42);
            });
        });
    });

    describe('negative values are clamped to min', () => {
        it('clamps a negative value below a positive min', () => {
            withEnv('-5', () => {
                expect(envInt(ENV_VAR, 5, { min: 1, max: 100 })).toBe(1);
            });
        });

        it('keeps a negative value when min allows it', () => {
            withEnv('-5', () => {
                expect(envInt(ENV_VAR, 5, { min: -10, max: 100 })).toBe(-5);
            });
        });
    });

    describe('zero is clamped when min is positive', () => {
        it('clamps zero up to min when min > 0', () => {
            withEnv('0', () => {
                expect(envInt(ENV_VAR, 5, { min: 1, max: 100 })).toBe(1);
            });
        });

        it('accepts zero when min is 0', () => {
            withEnv('0', () => {
                expect(envInt(ENV_VAR, 5, { min: 0, max: 100 })).toBe(0);
            });
        });
    });

    describe('overflow is clamped to max', () => {
        it('clamps a very large finite value to max', () => {
            withEnv('999999999', () => {
                expect(envInt(ENV_VAR, 5, { min: 1, max: 100 })).toBe(100);
            });
        });

        it('clamps an astronomically large value (beyond Number.MAX_SAFE_INTEGER) to max', () => {
            withEnv('99999999999999999999999999999999', () => {
                expect(envInt(ENV_VAR, 5, { min: 1, max: 100 })).toBe(100);
            });
        });
    });

    describe('boundary values pass through unchanged', () => {
        it('accepts exact min', () => {
            withEnv('1', () => {
                expect(envInt(ENV_VAR, 5, { min: 1, max: 100 })).toBe(1);
            });
        });

        it('accepts exact max', () => {
            withEnv('100', () => {
                expect(envInt(ENV_VAR, 5, { min: 1, max: 100 })).toBe(100);
            });
        });
    });

    describe('valid in-range values pass through unchanged', () => {
        it('accepts a mid-range value', () => {
            withEnv('50', () => {
                expect(envInt(ENV_VAR, 5, { min: 1, max: 100 })).toBe(50);
            });
        });

        it('parses values with surrounding whitespace via parseInt semantics', () => {
            withEnv('  7  ', () => {
                expect(envInt(ENV_VAR, 5, { min: 1, max: 100 })).toBe(7);
            });
        });
    });

    describe('no bounds provided', () => {
        it('returns the raw parsed value when min/max are omitted', () => {
            withEnv('-123', () => {
                expect(envInt(ENV_VAR, 5)).toBe(-123);
            });
        });
    });
});

describe('envMs (alias of envInt for millisecond durations)', () => {
    it('clamps negative durations to min', () => {
        withEnv('-1000', () => {
            expect(envMs(ENV_VAR, 60_000, { min: 1_000, max: 1_800_000 })).toBe(1_000);
        });
    });

    it('clamps zero to min when min > 0', () => {
        withEnv('0', () => {
            expect(envMs(ENV_VAR, 60_000, { min: 1_000, max: 1_800_000 })).toBe(1_000);
        });
    });

    it('falls back to default on malformed input', () => {
        withEnv('soon', () => {
            expect(envMs(ENV_VAR, 60_000, { min: 1_000, max: 1_800_000 })).toBe(60_000);
        });
    });

    it('clamps overflow to max', () => {
        withEnv('999999999999', () => {
            expect(envMs(ENV_VAR, 60_000, { min: 1_000, max: 1_800_000 })).toBe(1_800_000);
        });
    });

    it('accepts exact boundary values', () => {
        withEnv('1000', () => {
            expect(envMs(ENV_VAR, 60_000, { min: 1_000, max: 1_800_000 })).toBe(1_000);
        });
        withEnv('1800000', () => {
            expect(envMs(ENV_VAR, 60_000, { min: 1_000, max: 1_800_000 })).toBe(1_800_000);
        });
    });

    it('passes through a valid in-range value', () => {
        withEnv('120000', () => {
            expect(envMs(ENV_VAR, 60_000, { min: 1_000, max: 1_800_000 })).toBe(120_000);
        });
    });
});

describe('envBool', () => {
    it('returns the default when unset', () => {
        withEnv(undefined, () => {
            expect(envBool(ENV_VAR, false)).toBe(false);
            expect(envBool(ENV_VAR, true)).toBe(true);
        });
    });

    it('returns the default for malformed/unknown values', () => {
        withEnv('maybe', () => {
            expect(envBool(ENV_VAR, false)).toBe(false);
            expect(envBool(ENV_VAR, true)).toBe(true);
        });
    });

    it('parses truthy string variants', () => {
        for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on']) {
            withEnv(truthy, () => {
                expect(envBool(ENV_VAR, false)).toBe(true);
            });
        }
    });

    it('parses falsy string variants', () => {
        for (const falsy of ['0', 'false', 'FALSE', 'no', 'off']) {
            withEnv(falsy, () => {
                expect(envBool(ENV_VAR, true)).toBe(false);
            });
        }
    });
});

describe('envString', () => {
    it('returns the default when unset', () => {
        withEnv(undefined, () => {
            expect(envString(ENV_VAR, 'default')).toBe('default');
        });
    });

    it('returns the default for an empty/whitespace-only string', () => {
        withEnv('   ', () => {
            expect(envString(ENV_VAR, 'default')).toBe('default');
        });
    });

    it('trims and returns a valid value', () => {
        withEnv('  hello  ', () => {
            expect(envString(ENV_VAR, 'default')).toBe('hello');
        });
    });
});

describe('envCsv', () => {
    it('returns an empty array when unset', () => {
        withEnv(undefined, () => {
            expect(envCsv(ENV_VAR)).toEqual([]);
        });
    });

    it('splits, trims, and drops empty entries', () => {
        withEnv('a, b ,, c', () => {
            expect(envCsv(ENV_VAR)).toEqual(['a', 'b', 'c']);
        });
    });
});

describe('envEnum / envPerfProfile', () => {
    it('returns the default when unset', () => {
        withEnv(undefined, () => {
            expect(envEnum(ENV_VAR, ['a', 'b'] as const, 'a')).toBe('a');
        });
    });

    it('accepts an allowed value', () => {
        withEnv('b', () => {
            expect(envEnum(ENV_VAR, ['a', 'b'] as const, 'a')).toBe('b');
        });
    });

    it('throws on a disallowed value rather than silently defaulting', () => {
        withEnv('c', () => {
            expect(() => envEnum(ENV_VAR, ['a', 'b'] as const, 'a')).toThrow();
        });
    });

    it('envPerfProfile defaults to "default" when unset', () => {
        const original = process.env.CE_PERF_PROFILE;
        delete process.env.CE_PERF_PROFILE;
        try {
            expect(envPerfProfile()).toBe('default');
        } finally {
            if (original === undefined) delete process.env.CE_PERF_PROFILE;
            else process.env.CE_PERF_PROFILE = original;
        }
    });
});
