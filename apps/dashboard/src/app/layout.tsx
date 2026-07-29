import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Assay — proof of execution for onchain agents',
  description:
    'Commit intent onchain, execute through KeeperHub, reconcile against independently ' +
    'read chain state, and record a hash-chained verdict.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
