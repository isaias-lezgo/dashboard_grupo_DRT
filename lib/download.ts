// Client-side file download helper. Builds a Blob and triggers a browser
// download via a transient anchor element. Shared by the CSV export tool and
// the AI-chat transcript export.

export function triggerDownload({
  content,
  filename,
  mimeType,
}: {
  content: string;
  filename: string;
  mimeType: string;
}): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Variant for binary artifacts (e.g. a generated PDF) where the source is
// already a Blob rather than a string. Same transient-anchor mechanism.
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
