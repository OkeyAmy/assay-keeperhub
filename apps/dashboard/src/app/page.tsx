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

export default async function Page() {
  const data = await loadReceipts();

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
        </dl>
      </section>

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

              <dt>Reason hash</dt>
              <dd>
                {/* keccak256 of the reason code, so the string is recoverable
                    without trusting this page: cast keccak "CALLDATA_MISMATCH". */}
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
                <span className="command-label">Recover the reason code from its hash</span>
                <Copyable
                  className="command"
                  value={`cast keccak "ALL_CHECKS_PASSED"   # compare against ${row.reasonHash}`}
                  title="Recover reason code"
                />
              </li>
            </ul>
          </details>
        </td>
      </tr>
    </>
  );
}
