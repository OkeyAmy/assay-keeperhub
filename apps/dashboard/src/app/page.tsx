import { loadReceipts, shorten, type ExplorerData, type ReceiptRow } from '../lib/receipts';
import { Copyable } from '../components/Copyable';

// Receipts are appended continuously, so never serve a cached page.
export const dynamic = 'force-dynamic';

const VERDICT_STYLE: Record<string, string> = {
  VERIFIED: 'verdict verified',
  DIVERGENT: 'verdict divergent',
  UNPROVEN: 'verdict unproven',
  NOT_EXECUTED: 'verdict not-executed',
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const requestedPage = Number((await searchParams).page ?? 0);
  const data = await loadReceipts({
    page: Number.isFinite(requestedPage) ? requestedPage : 0,
    pageSize: 20,
  });

  return (
    <main>
      <header>
        <h1>Assay</h1>
        <p className="tagline">
          Proof of execution for onchain agents. Every row is a verdict on whether a
          KeeperHub execution did what the agent committed to — reconciled against
          chain state read through providers that are not KeeperHub.
        </p>
      </header>

      <section className="stats">
        <Stat label="Verified" value={data.summary.VERIFIED} tone="verified" />
        <Stat label="Divergent" value={data.summary.DIVERGENT} tone="divergent" />
        <Stat label="Unproven" value={data.summary.UNPROVEN} tone="unproven" />
        <Stat label="Not executed" value={data.summary.NOT_EXECUTED} tone="not-executed" />
        <Stat label="Total onchain" value={data.total} tone="neutral" />
      </section>

      <section className="meta">
        <dl>
          <dt>Chain</dt>
          <dd>{data.chainId}</dd>
          <dt>Independent RPC providers</dt>
          <dd>
            {data.providersAgreeing}/{data.providerCount} agreeing, quorum{' '}
            {data.quorumRequired}
          </dd>
          <dt>ReceiptRegistry</dt>
          <dd>
            {data.receiptRegistry ? (
              data.registryUrl ? (
                <a href={data.registryUrl} target="_blank" rel="noreferrer">
                  {shorten(data.receiptRegistry, 8)}
                </a>
              ) : (
                shorten(data.receiptRegistry, 8)
              )
            ) : (
              <span className="muted">not configured</span>
            )}
          </dd>
          {data.verifier ? (
            <>
              <dt>Verifier (KeeperHub org wallet)</dt>
              <dd>
                {data.verifierUrl ? (
                  <a href={data.verifierUrl} target="_blank" rel="noreferrer">
                    {shorten(data.verifier, 8)}
                  </a>
                ) : (
                  shorten(data.verifier, 8)
                )}
              </dd>
            </>
          ) : null}
        </dl>
      </section>

      <ExecutedThroughKeeperHub data={data} />

      {data.error ? (
        <section className="notice">
          <strong>Cannot read receipts.</strong> {data.error}
          <p className="muted">
            Set <code>RECEIPT_REGISTRY</code> and <code>RPC_URLS</code> in <code>.env</code>,
            then deploy the registries with <code>pnpm --filter @assay/contracts run deploy</code>.
          </p>
        </section>
      ) : null}

      {data.rows.length === 0 && !data.error ? (
        <section className="notice">
          <strong>No receipts yet.</strong>
          <p className="muted">
            Run <code>pnpm --filter @assay/runner run once</code> to produce one, or{' '}
            <code>pnpm gauntlet</code> to see the four failure modes without touching a chain.
          </p>
        </section>
      ) : null}

      {data.rows.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Verdict</th>
              <th>Intent</th>
              <th>Transaction</th>
              <th>Chain link</th>
              <th>Observed</th>
              <th>Block</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <Row key={row.receiptHash} row={row} data={data} />
            ))}
          </tbody>
        </table>
      ) : null}

      {data.unreadable > 0 ? (
        <p className="muted unreadable-note">
          {data.unreadable} receipt{data.unreadable === 1 ? '' : 's'} on this page could not be
          read through the RPC quorum and {data.unreadable === 1 ? 'is' : 'are'} not shown. They
          are still onchain — reload, or read them directly with{' '}
          <code>cast call … chainFrom(…)</code>.
        </p>
      ) : null}

      {data.rows.length > 0 ? <Pagination page={data.page} pageCount={data.pageCount} /> : null}

      <footer>
        <p className="muted">
          <strong>UNPROVEN is a real answer.</strong> It means the evidence was
          insufficient — not that the execution was fine. Nothing in this system
          upgrades an UNPROVEN to a VERIFIED.
        </p>
      </footer>
    </main>
  );
}

/**
 * Who executed, and how to exercise this deployment yourself.
 *
 * The table below says what the verdicts were but not who produced them, which
 * leaves the reader to assume. Every transaction behind these receipts was
 * broadcast by KeeperHub's Direct Execution API — the wallet above signs, not
 * this codebase — and the two commands here are the interaction surface that
 * needs no credentials and cannot be broken by using it.
 */
function ExecutedThroughKeeperHub({ data }: { data: ExplorerData }) {
  const slug = data.marketplaceSlug ?? 'assay-verify';

  return (
    <section className="keeperhub">
      <h2>Executed through KeeperHub</h2>

      <p className="muted">
        Each verification cycle is <strong>three</strong> KeeperHub Direct Execution
        transactions: the intent commitment, the value-moving action, and the receipt
        below. No private key in this codebase signs any of them — the reads that check
        them deliberately go through providers that are <em>not</em> KeeperHub, which is
        what stops a verdict being circular.
      </p>

      <ul className="commands">
        <li>
          <span className="command-label">
            Verify this deployment through KeeperHub&apos;s marketplace — returns a live
            x402 challenge, no account needed
          </span>
          <Copyable
            className="command"
            value={`curl -s -X POST https://app.keeperhub.com/api/mcp/workflows/${slug}/call -H 'content-type: application/json' -d '{}'`}
            title="Call the marketplace workflow"
          />
        </li>
        <li>
          <span className="command-label">
            Read the same tally this page shows, straight from chain — nothing from this
            project involved
          </span>
          <Copyable
            className="command"
            value={`cast call ${data.receiptRegistry ?? '$RECEIPT_REGISTRY'} "summary(address)(uint256,uint256,uint256,uint256)" ${data.verifier ?? '$VERIFIER'} --rpc-url ${data.rpcUrl ?? '$RPC_URL'}`}
            title="Read the verdict tally"
          />
        </li>
      </ul>
    </section>
  );
}

function Pagination({ page, pageCount }: { page: number; pageCount: number }) {
  // Page 0 is the newest receipts; higher pages walk backward into history.
  const hasNext = page < pageCount - 1;
  const hasPrev = page > 0;

  return (
    <nav className="pagination" aria-label="Receipt pages">
      {hasNext ? (
        <a className="page-link" href={`?page=${page + 1}`}>
          Next
        </a>
      ) : (
        <span className="page-link disabled">Next</span>
      )}
      {hasPrev ? (
        <a className="page-link" href={page - 1 === 0 ? '?' : `?page=${page - 1}`}>
          Prev
        </a>
      ) : (
        <span className="page-link disabled">Prev</span>
      )}
      <span className="page-status muted">
        Page {page + 1} of {pageCount}
      </span>
    </nav>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`stat ${tone}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function Row({ row, data }: { row: ReceiptRow; data: ExplorerData }) {
  const rpc = data.rpcUrl ?? '$RPC_URL';

  return (
    <>
      <tr>
        <td>
          <span className={VERDICT_STYLE[row.verdict] ?? 'verdict'}>{row.verdict}</span>
          {/* The reason is the interesting half of a DIVERGENT or UNPROVEN row,
              and onchain it is only a hash. Decoding it here saves the reader a
              `cast keccak` per row to learn why. */}
          <span className="reason-code" title="Reason code, recovered from its hash">
            {row.reason ?? 'unrecognised reason'}
          </span>
        </td>
        <td>
          <Copyable value={row.intentHash} display={shorten(row.intentHash)} title="Intent hash" />
        </td>
        <td>
          {row.explorerUrl ? (
            <Copyable value={row.txHash} display={shorten(row.txHash)} title="Transaction hash" />
          ) : (
            <span className="muted" title="KeeperHub reported no transaction hash (issue #1784)">
              none reported
            </span>
          )}
        </td>
        <td>
          {row.explorerUrl ? (
            <a href={row.explorerUrl} target="_blank" rel="noreferrer">
              view
            </a>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td>{new Date(row.observedAt * 1000).toISOString().replace('T', ' ').slice(0, 19)}</td>
        <td>{row.blockNumber}</td>
      </tr>
      <tr className="detail-row">
        <td colSpan={6}>
          <details>
            <summary>Verify this receipt yourself</summary>

            <dl className="fields">
              <dt>Receipt hash</dt>
              <dd>
                <Copyable value={row.receiptHash} title="Receipt hash" />
              </dd>

              <dt>Previous receipt</dt>
              <dd>
                {/* The chain link. Recomputing the head from these is what makes
                    a dropped or reordered receipt visible. */}
                <Copyable value={row.prevHash} title="Previous receipt hash" />
              </dd>

              <dt>Intent hash</dt>
              <dd>
                <Copyable value={row.intentHash} title="Intent hash" />
              </dd>

              <dt>Transaction</dt>
              <dd>
                {row.explorerUrl ? (
                  <>
                    <Copyable value={row.txHash} title="Transaction hash" />{' '}
                    <a href={row.explorerUrl} target="_blank" rel="noreferrer">
                      open in explorer
                    </a>
                  </>
                ) : (
                  <span className="muted">
                    none reported — KeeperHub issue #1784, recorded as UNPROVEN rather than skipped
                  </span>
                )}
              </dd>

              <dt>Reason</dt>
              <dd>
                {/* Shown as the code plus the hash actually stored onchain, so
                    the decoding can be checked rather than believed. */}
                {row.reason ? (
                  <>
                    <strong>{row.reason}</strong>{' '}
                    <span className="muted">= keccak of that string:</span>{' '}
                  </>
                ) : (
                  <span className="muted">
                    no known reason hashes to this — written by another verifier:{' '}
                  </span>
                )}
                <Copyable value={row.reasonHash} title="Reason hash" />
              </dd>

              <dt>Verifier</dt>
              <dd>
                <Copyable value={row.verifier} title="Verifier address" />
              </dd>
            </dl>

            <p className="muted">
              These commands read the same registry this page reads, straight from chain.
              Nothing from this repository is involved.
            </p>

            <ul className="commands">
              <li>
                <span className="command-label">Was the intent committed before execution?</span>
                <Copyable
                  className="command"
                  value={`cast call ${data.intentRegistry ?? '$INTENT_REGISTRY'} "isCommitted(bytes32)(bool)" ${row.intentHash} --rpc-url ${rpc}`}
                  title="Check commitment"
                />
              </li>
              <li>
                <span className="command-label">Read this verifier&apos;s chain head</span>
                <Copyable
                  className="command"
                  value={`cast call ${data.receiptRegistry ?? '$RECEIPT_REGISTRY'} "head(address)(bytes32)" ${row.verifier} --rpc-url ${rpc}`}
                  title="Read chain head"
                />
              </li>
              <li>
                <span className="command-label">
                  Check this page decoded the reason honestly — should print{' '}
                  {row.reasonHash}
                </span>
                <Copyable
                  className="command"
                  value={`cast keccak "${row.reason ?? 'ALL_CHECKS_PASSED'}"`}
                  title="Recompute the reason hash"
                />
              </li>
            </ul>
          </details>
        </td>
      </tr>
    </>
  );
}
