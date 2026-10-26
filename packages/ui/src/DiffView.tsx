export function DiffView({ unified }: { unified: string }) {
  const lines = unified.split(/\r?\n/).slice(0, 400);
  return (
    <pre className="max-h-[50vh] overflow-auto rounded-lg border border-[#2a2e3a] bg-[#0a0b0f] p-3 font-mono text-[12px] leading-5">
      {lines.map((line, i) => {
        const cls = line.startsWith("+")
          ? "text-emerald-300"
          : line.startsWith("-") && !line.startsWith("---")
            ? "text-rose-300"
            : line.startsWith("@@")
              ? "text-violet-300"
              : "text-[#9aa0b4]";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
