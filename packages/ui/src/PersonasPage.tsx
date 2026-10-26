import { useEffect, useState } from "react";
import { createPersona, deletePersona, listPersonas, updatePersona } from "./api.js";
import type { Persona } from "./types.js";

export function PersonasPage({ onChange }: { onChange?: (list: Persona[]) => void }) {
  const [list, setList] = useState<Persona[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [greeting, setGreeting] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  async function reload(selectId?: string | null) {
    const next = await listPersonas();
    setList(next);
    onChange?.(next);
    const pick = selectId ? next.find((p) => p.id === selectId) : next[0];
    if (pick) {
      setCurrentId(pick.id);
      setName(pick.name);
      setBody(pick.body);
      setGreeting(pick.greeting);
    } else {
      setCurrentId(null);
      setName("");
      setBody("");
      setGreeting("");
    }
  }

  useEffect(() => {
    void reload().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  function startNew() {
    setCurrentId(null);
    setName("新人设");
    setBody("");
    setGreeting("");
    setSaved("");
  }

  return (
    <div className="settings">
      <h2>人设</h2>
      <p className="hint">
        已经放好几个默认人设，点一个就能改、也能用到对话里。新对话会先用「通用助手」，顶栏可以换成别的或关掉。人设只影响语气，不会放开内容规范或服务器终端。
      </p>
      {list.length ? (
        <div className="feedback-kinds" role="listbox" aria-label="默认人设">
          {list.map((p) => (
            <button
              key={p.id}
              type="button"
              className={currentId === p.id ? "chip is-on" : "chip"}
              onClick={() => {
                setCurrentId(p.id);
                setName(p.name);
                setBody(p.body);
                setGreeting(p.greeting);
                setSaved("");
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="toolbar">
        <button className="btn btn-primary" type="button" onClick={startNew}>
          新建
        </button>
        <select
          className="select"
          value={currentId ?? ""}
          onChange={(e) => {
            const pick = list.find((p) => p.id === e.target.value);
            if (!pick) return startNew();
            setCurrentId(pick.id);
            setName(pick.name);
            setBody(pick.body);
            setGreeting(pick.greeting);
            setSaved("");
          }}
        >
          <option value="">选择已有人设…</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <label className="hint" style={{ display: "block", marginTop: 16 }}>
        <div>名称</div>
        <input className="field" style={{ width: "100%", marginTop: 6 }} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="hint" style={{ display: "block", marginTop: 16 }}>
        <div>人设正文</div>
        <textarea
          className="field area"
          style={{ width: "100%", marginTop: 6 }}
          rows={10}
          placeholder="例如：你是沉稳的产品经理，用短句回答，先说结论。"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <label className="hint" style={{ display: "block", marginTop: 16 }}>
        <div>开场白（可选，空对话加载人设时会插入一条助手消息）</div>
        <input
          className="field"
          style={{ width: "100%", marginTop: 6 }}
          value={greeting}
          onChange={(e) => setGreeting(e.target.value)}
        />
      </label>
      <div className="toolbar">
        <button
          className="btn btn-primary"
          type="button"
          onClick={async () => {
            try {
              const payload = { name, body, greeting };
              const savedRow = currentId ? await updatePersona(currentId, payload) : await createPersona(payload);
              setSaved("已保存");
              setError("");
              await reload(savedRow.id);
              setTimeout(() => setSaved(""), 2000);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          保存
        </button>
        {currentId ? (
          <button
            className="btn"
            type="button"
            onClick={async () => {
              await deletePersona(currentId);
              await reload();
            }}
          >
            删除
          </button>
        ) : null}
        {saved ? <span className="hint">{saved}</span> : null}
      </div>
      {error ? <div className="error">{error}</div> : null}
    </div>
  );
}
