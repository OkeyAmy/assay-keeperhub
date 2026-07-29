'use client';

import { useState } from 'react';

/**
 * A value shown truncated, copied in full.
 *
 * Everything on this page is meant to be checked somewhere else — pasted into a
 * block explorer, a `cast` command, or another verifier. A hash you cannot copy
 * is a hash you have to take on trust, which is the opposite of the point.
 */
export function Copyable({
  value,
  display,
  title,
  className,
}: {
  value: string;
  display?: string;
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access can be denied (insecure origin, permissions policy).
      // Falling back to a selection keeps the value obtainable by hand rather
      // than failing silently and looking like the button is broken.
      fallbackSelect(value);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <span className={`copyable ${className ?? ''}`}>
      <code title={title ?? value}>{display ?? value}</code>
      <button
        type="button"
        onClick={copy}
        className="copy-button"
        aria-label={`Copy ${title ?? value}`}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  );
}

/** Put the text in a selected, off-screen field so the user can still take it. */
function fallbackSelect(value: string): void {
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  document.execCommand('copy');
  document.body.removeChild(field);
}
