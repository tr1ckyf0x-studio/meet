// Small behaviours for every page (CSP forbids inline handlers).

document.addEventListener("submit", (e) => {
  const f = e.target as HTMLFormElement;
  const msg = f.dataset.confirm;
  if (msg && !confirm(msg)) e.preventDefault();
});

document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-copy]");
  if (!b) return;
  const text = b.dataset.copy!;
  void navigator.clipboard?.writeText(text).then(() => {
    const old = b.textContent;
    b.textContent = b.dataset.copied ?? "✓";
    setTimeout(() => { b.textContent = old; }, 1500);
  });
});

// The welcome page preselects the browser's time zone.
for (const sel of document.querySelectorAll<HTMLSelectElement>("select[data-detect-tz]")) {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && sel.value === "UTC" && [...sel.options].some((o) => o.value === tz)) sel.value = tz;
  } catch { /* old browser */ }
}
