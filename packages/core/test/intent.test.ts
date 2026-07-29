/**
 * Assertion sources used in this file:
 *   contract  — behaviour declared in src/intent.ts
 *   invariant — canonicalisation properties the commitment scheme depends on
 */
import { describe, expect, it } from 'vitest';
import {
  calldataMatchesIntent,
  hashBounds,
  hashIntent,
  hashPolicy,
  intentCalldata,
  isExpired,
  serialiseIntent,
  ZERO_ADDRESS,
} from '../src/intent.js';
import { AGENT, makeIntent, TRANSFER_TOPIC, transferArgs, USDC, VAULT } from './fixtures.js';

describe('hashIntent', () => {
  it('is stable for identical intents', () => {
    // blindfold: contract — hashIntent is a pure function of the intent fields
    expect(hashIntent(makeIntent())).toBe(hashIntent(makeIntent()));
  });

  it('changes when any committed field changes', () => {
    const base = hashIntent(makeIntent());

    // blindfold: invariant — every field is in the preimage, so none can change unnoticed after commitment
    expect(hashIntent(makeIntent({ nonce: 2n }))).not.toBe(base);
    expect(hashIntent(makeIntent({ value: 1n }))).not.toBe(base);
    expect(hashIntent(makeIntent({ chainId: 1 }))).not.toBe(base);
    expect(hashIntent(makeIntent({ deadline: 123n }))).not.toBe(base);
    expect(hashIntent(makeIntent({ target: AGENT }))).not.toBe(base);
    expect(hashIntent(makeIntent({ args: transferArgs(AGENT, 1n) }))).not.toBe(base);
  });

  it('changes when the declared effect bounds change', () => {
    const base = hashIntent(makeIntent());
    const widened = makeIntent({
      bounds: { ...makeIntent().bounds, maxGasUsed: 999_999n },
    });

    // blindfold: invariant — bounds are part of the promise, so loosening them must break the hash
    expect(hashIntent(widened)).not.toBe(base);
  });
});

describe('hashBounds — canonicalisation', () => {
  /**
   * Without sorting, the hash would depend on JS object iteration order, which
   * is not a property anyone should be committing to onchain.
   */
  it('is independent of balance-delta ordering', () => {
    const amount = 10_000_000n;
    const forward = {
      balanceDeltas: [
        { token: USDC, account: AGENT, min: -amount, max: -amount },
        { token: USDC, account: VAULT, min: amount, max: amount },
      ],
      requiredTopics: [],
      maxGasUsed: 0n,
    };
    const reversed = { ...forward, balanceDeltas: [...forward.balanceDeltas].reverse() };

    // blindfold: invariant — declared bounds are a set, so their hash must not depend on array order
    expect(hashBounds(forward)).toBe(hashBounds(reversed));
  });

  it('is independent of required-topic ordering', () => {
    const a = { balanceDeltas: [], requiredTopics: [TRANSFER_TOPIC, `0x${'11'.repeat(32)}`], maxGasUsed: 0n } as const;
    const b = { balanceDeltas: [], requiredTopics: [`0x${'11'.repeat(32)}`, TRANSFER_TOPIC], maxGasUsed: 0n } as const;

    // blindfold: invariant — required topics are a set, not a sequence
    expect(hashBounds(a)).toBe(hashBounds(b));
  });

  it('still distinguishes genuinely different bounds', () => {
    const tight = { balanceDeltas: [], requiredTopics: [], maxGasUsed: 100n } as const;
    const loose = { balanceDeltas: [], requiredTopics: [], maxGasUsed: 200n } as const;

    // blindfold: contract — canonicalisation normalises order only, never content
    expect(hashBounds(tight)).not.toBe(hashBounds(loose));
  });
});

describe('calldata', () => {
  it('concatenates selector and args', () => {
    const intent = makeIntent();

    // blindfold: contract — intentCalldata is documented as selector followed by encoded args
    expect(intentCalldata(intent)).toBe(`${intent.selector}${intent.args.slice(2)}`);
  });

  it('matches identical calldata regardless of case', () => {
    const intent = makeIntent();
    const upper = intentCalldata(intent).toUpperCase().replace('0X', '0x') as `0x${string}`;

    // blindfold: contract — comparison is lowercased, since hex casing carries no meaning
    expect(calldataMatchesIntent(intent, upper)).toBe(true);
  });

  it('rejects calldata differing by a single byte', () => {
    const intent = makeIntent();
    const tampered = transferArgs(VAULT, 10_000_001n);

    // blindfold: invariant — near-miss calldata is still a miss; tolerance here would let decimal errors through
    expect(calldataMatchesIntent(intent, `0xa9059cbb${tampered.slice(2)}`)).toBe(false);
  });
});

describe('isExpired', () => {
  it('is false before the deadline and true after it', () => {
    const intent = makeIntent({ deadline: 1_000n });

    // blindfold: contract — isExpired compares now > deadline, so the deadline second itself is still live
    expect(isExpired(intent, 999n)).toBe(false);
    expect(isExpired(intent, 1_000n)).toBe(false);
    expect(isExpired(intent, 1_001n)).toBe(true);
  });
});

describe('serialiseIntent', () => {
  it('produces identical output for equivalent intents in different orders', () => {
    const amount = 10_000_000n;
    const bounds = {
      balanceDeltas: [
        { token: USDC, account: AGENT, min: -amount, max: -amount },
        { token: USDC, account: VAULT, min: amount, max: amount },
      ],
      requiredTopics: [TRANSFER_TOPIC],
      maxGasUsed: 100_000n,
    };
    const forward = makeIntent({ bounds });
    const reversed = makeIntent({
      bounds: { ...bounds, balanceDeltas: [...bounds.balanceDeltas].reverse() },
    });

    // blindfold: invariant — the log line for an intent must be reproducible across processes
    expect(serialiseIntent(forward)).toBe(serialiseIntent(reversed));
  });

  it('renders bigints as decimal strings', () => {
    // blindfold: contract — bigint has no JSON representation, so serialiseIntent declares decimal strings
    expect(serialiseIntent(makeIntent())).toContain('"value":"0"');
  });
});

describe('hashPolicy', () => {
  it('distinguishes different policies', () => {
    // blindfold: contract — policyHash makes the operating policy part of the commitment, so drift is auditable
    expect(hashPolicy({ cap: 1 })).not.toBe(hashPolicy({ cap: 2 }));
    expect(hashPolicy({ cap: 1 })).toBe(hashPolicy({ cap: 1 }));
  });
});

describe('ZERO_ADDRESS', () => {
  it('is the native-asset sentinel used by balance bounds', () => {
    // blindfold: contract — observer routes ZERO_ADDRESS to getBalance instead of balanceOf
    expect(ZERO_ADDRESS).toBe('0x0000000000000000000000000000000000000000');
  });
});
