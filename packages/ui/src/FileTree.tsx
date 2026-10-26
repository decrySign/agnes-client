import type { FileNode } from "./types.js";

export function FileTree({
  nodes,
  active,
  onOpen,
}: {
  nodes: FileNode[];
  active?: string;
  onOpen: (node: FileNode) => void;
}) {
  return (
    <ul className="text-[13px] leading-6">
      {nodes.map((node) => (
        <li key={node.path} className="pl-1">
          <button
            type="button"
            className={`flex w-full items-center gap-1 rounded px-1 text-left hover:bg-[#232633] ${
              active === node.path ? "bg-[#2a2450] text-white" : "text-[#c8ccda]"
            }`}
            onClick={() => onOpen(node)}
          >
            <span className="opacity-60">{node.type === "dir" ? "▸" : "·"}</span>
            <span className="truncate">{node.name}</span>
          </button>
          {node.children && node.children.length > 0 ? (
            <div className="ml-3 border-l border-[#2a2e3a] pl-1">
              <FileTree nodes={node.children} active={active} onOpen={onOpen} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
