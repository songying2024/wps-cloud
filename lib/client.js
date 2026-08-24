// @dsh-local/wps-cloud — 浏览器端（client half）。
// 1) “设置 → WPS 云文档”设置页：显示登录状态，提供“登录 / 退出登录”。
// 2) 对话输入框 + 号左侧的“WPS 云文档”附件图标：
//    - 弹出面板浏览 WPS 云文档（目录树 + 搜索），点击文件 → 生成“读取我的WPS云文档《xxx》”指令填入输入框；
//    - 提供“上传本地文档”入口：因浏览器拿不到本地绝对路径、DSH 原生附件仅支持图片，
//      本地文件由前端 POST 到插件服务端暂存到本机 .dsh/wps-uploads，再让 Agent 读取该路径（不上传云端）。
window.__ModuleLoader__.load({
  id: "@dsh-local/wps-cloud",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    const h = react.createElement;

    /* ---------------- 样式 ---------------- */
    const CSS = `
.wpsc-card { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px; }
.wpsc-status { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--dsw-alias-label-primary, #0f1115); }
.wpsc-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
.wpsc-dot-ok { background: var(--dsw-alias-state-success-primary, #16a34a); }
.wpsc-dot-bad { background: var(--dsw-alias-state-error-primary, #dc2626); }
.wpsc-dot-wait { background: var(--dsw-alias-state-warning-primary, #d97706); }
.wpsc-row { font-size: 13px; color: var(--dsw-alias-label-secondary, #41464e); line-height: 1.8; }
.wpsc-actions { display: flex; gap: 10px; margin-top: 4px; }
.wpsc-btn {
  padding: 7px 16px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12));
  background: transparent; color: var(--dsw-alias-label-primary, #0f1115); font-size: 13px; cursor: pointer;
}
.wpsc-btn:hover { border-color: var(--dsw-alias-brand-primary, #0f1115); color: var(--dsw-alias-brand-primary, #0f1115); }
.wpsc-btn-primary { background: var(--dsw-alias-brand-primary, #0f1115); border-color: transparent; color: var(--dsw-alias-bg-base, #ffffff); }
.wpsc-btn-primary:hover { opacity: 0.88; color: var(--dsw-alias-bg-base, #ffffff); }
.wpsc-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #6b7280); line-height: 1.7; }
.wpsc-err { font-size: 12px; color: var(--dsw-alias-state-error-primary, #dc2626); }

/* 输入框附件按钮 */
.wpsc-composer-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border: none; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-secondary, #41464e);
  cursor: pointer; flex: 0 0 auto;
}
.wpsc-composer-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); color: var(--dsw-alias-label-primary, #0f1115); }

/* 面板（与 DSH 主题一致：浅色/深色自动跟随 --dsw-alias-* 变量） */
.wpsc-overlay { position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,0.45); display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh; }
.wpsc-panel {
  width: min(640px, calc(100vw - 40px)); max-height: 72vh; display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-surface, var(--dsw-alias-bg-base, #ffffff));
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08));
  border-radius: 14px;
  box-shadow: 0 16px 48px rgba(0,0,0,0.22), 0 2px 10px rgba(0,0,0,0.10);
  overflow: hidden; font-size: 13px; color: var(--dsw-alias-label-primary, #0f1115);
}
.wpsc-panel-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 8px; }
.wpsc-panel-title { font-size: 14px; font-weight: 600; flex: 1; display: flex; align-items: center; gap: 8px; }
.wpsc-close { width: 26px; height: 26px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #41464e); cursor: pointer; border-radius: 6px; font-size: 16px; line-height: 1; }
.wpsc-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); color: var(--dsw-alias-label-primary, #0f1115); }
.wpsc-toolbar { display: flex; gap: 8px; padding: 0 14px 10px; align-items: center; }
.wpsc-search {
  flex: 1; display: flex; gap: 6px; align-items: center; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.10));
  border-radius: 10px; padding: 5px 10px; background: var(--dsw-alias-bg-input, rgba(0,0,0,0.03));
}
.wpsc-search input { flex: 1; border: none; outline: none; background: transparent; color: var(--dsw-alias-label-primary, #0f1115); font-size: 13px; }
.wpsc-search input::placeholder { color: var(--dsw-alias-label-tertiary, #6b7280); }
.wpsc-upload-btn {
  padding: 6px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.10));
  background: transparent; color: var(--dsw-alias-label-secondary, #41464e); cursor: pointer; font-size: 13px; white-space: nowrap;
}
.wpsc-upload-btn:hover { border-color: var(--dsw-alias-brand-primary, #0f1115); color: var(--dsw-alias-brand-primary, #0f1115); }
.wpsc-crumbs { display: flex; align-items: center; gap: 2px; padding: 0 14px 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, #41464e); overflow-x: auto; white-space: nowrap; }
.wpsc-crumb { border: none; background: transparent; color: inherit; cursor: pointer; padding: 3px 6px; border-radius: 6px; font-size: 12px; }
.wpsc-crumb:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); color: var(--dsw-alias-label-primary, #0f1115); }
.wpsc-crumb-cur { color: var(--dsw-alias-label-primary, #0f1115); font-weight: 500; }
.wpsc-crumb-sep { opacity: 0.5; }
.wpsc-list { flex: 1; overflow-y: auto; padding: 0 8px 8px; min-height: 160px; }
.wpsc-row-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
.wpsc-row-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }
.wpsc-item-icon { flex: 0 0 auto; display: flex; color: var(--dsw-alias-label-secondary, #41464e); }
.wpsc-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary, #0f1115); }
.wpsc-item-meta { flex: 0 0 auto; font-size: 12px; color: var(--dsw-alias-label-tertiary, #6b7280); }
.wpsc-item-open { flex: 0 0 auto; font-size: 12px; color: var(--dsw-alias-brand-primary, #0f1115); opacity: 0; }
.wpsc-row-item:hover .wpsc-item-open { opacity: 1; }
.wpsc-empty { text-align: center; color: var(--dsw-alias-label-tertiary, #6b7280); padding: 40px 0; font-size: 13px; }
.wpsc-panel-foot { display: flex; align-items: center; gap: 8px; padding: 8px 14px 12px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #6b7280); border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08)); }
.wpsc-loading { text-align: center; color: var(--dsw-alias-label-secondary, #41464e); padding: 40px 0; }
.wpsc-unauth { text-align: center; padding: 36px 20px; display: flex; flex-direction: column; gap: 14px; align-items: center; }
.wpsc-unauth-tip { color: var(--dsw-alias-label-secondary, #41464e); font-size: 13px; line-height: 1.7; }
.wpsc-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 10001; background: var(--dsw-alias-bg-surface, var(--dsw-alias-bg-base, #ffffff)); border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12)); border-radius: 10px; padding: 9px 16px; font-size: 13px; color: var(--dsw-alias-label-primary, #0f1115); box-shadow: 0 8px 24px rgba(0,0,0,0.2); }
`;

    /* ---------------- 图标 ---------------- */
    function IconCloud(props) {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: props.size || 18, height: props.size || 18, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinejoin: "round", strokeLinecap: "round" },
        h("path", { d: "M7 18a4 4 0 0 1-.5-7.97A5 5 0 0 1 16.5 8.5 3.5 3.5 0 0 1 17 15.5H7z" }),
        h("path", { d: "M12 10v7M9.5 14.5 12 17l2.5-2.5" }),
      );
    }
    function IconFolder() {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: 16, height: 16, fill: "currentColor", opacity: 0.9 },
        h("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" }),
      );
    }
    function IconFile() {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinejoin: "round" },
        h("path", { d: "M6 3h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" }),
        h("path", { d: "M13 3v5h5", strokeLinecap: "round" }),
      );
    }

    /* ---------------- 通用工具 ---------------- */
    function formatTime(ts) {
      if (!ts) return "";
      try {
        const d = new Date(ts * 1000);
        const pad = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      } catch {
        return "";
      }
    }
    function formatBytes(size) {
      if (!size && size !== 0) return "";
      if (size < 1024) return size + " B";
      const units = ["KB", "MB", "GB", "TB"];
      let n = size / 1024;
      let i = 0;
      while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i += 1;
      }
      return n.toFixed(n >= 100 ? 0 : 1) + " " + units[i];
    }
    async function fetchJson(url, options) {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }
    async function uploadLocalFile(file) {
      const body = await file.arrayBuffer();
      return fetchJson(
        `/wps-oauth/upload-local?name=${encodeURIComponent(file.name)}`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body },
      );
    }

    /* ---------------- 设置页（保留） ---------------- */
    function WpsSettingsPage() {
      const [state, setState] = react.useState({
        loading: true, authorized: false, nickname: null, hasSid: false,
      });
      const [error, setError] = react.useState("");

      const refresh = react.useCallback(() => {
        fetch("/wps-oauth/status", { headers: { accept: "application/json" }, cache: "no-store" })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
          .then((data) => {
            setState({ loading: false, ...data });
            setError("");
          })
          .catch((err) => {
            setState((s) => ({ ...s, loading: false }));
            setError("无法获取状态：" + (err && err.message ? err.message : String(err)));
          });
      }, []);

      react.useEffect(() => {
        refresh();
        const timer = window.setInterval(refresh, 2000);
        return () => window.clearInterval(timer);
      }, [refresh]);

      const login = () => {
        setError("");
        fetch("/wps-oauth/login", { method: "POST" })
          .then((r) => r.json())
          .then((data) => {
            if (data.ok) {
              setError("已打开 WPS 网页版登录窗口，请在弹出的浏览器中登录 WPS 账号…");
            } else {
              setError(data.error || "登录发起失败");
            }
          })
          .catch((err) => setError("登录发起失败：" + (err && err.message ? err.message : String(err))));
      };
      const logout = () => {
        fetch("/wps-oauth/logout", { method: "POST" })
          .then(() => refresh())
          .catch((err) => setError("退出失败：" + (err && err.message ? err.message : String(err))));
      };

      const dot = state.loading
        ? h("span", { className: "wpsc-dot wpsc-dot-wait" })
        : h("span", { className: "wpsc-dot " + (state.authorized ? "wpsc-dot-ok" : "wpsc-dot-bad") });
      const statusText = state.loading ? "正在检查…" : state.authorized ? "已登录" : "未登录";

      const rows = [];
      if (state.authorized) {
        if (state.nickname) rows.push(h("div", { className: "wpsc-row", key: "who" }, "当前用户：" + state.nickname));
        rows.push(h("div", { className: "wpsc-row", key: "ok" }, "登录后即可在对话中让 Agent 浏览、读取、上传、下载你的 WPS 云文档。"));
      } else if (!state.loading) {
        rows.push(h("div", { className: "wpsc-row", key: "nol" }, "点击下方按钮，会弹出 WPS 网页版（365.kdocs.cn）登录窗口：用你的 WPS 账号登录后，插件自动完成绑定，无需开发者账号。"));
      }

      const actions = [];
      if (state.authorized) {
        actions.push(h("button", { className: "wpsc-btn", key: "logout", onClick: logout }, "退出登录"));
      } else {
        actions.push(h("button", { className: "wpsc-btn wpsc-btn-primary", key: "login", onClick: login }, "登录 WPS 云文档"));
      }
      actions.push(h("button", { className: "wpsc-btn", key: "refresh", onClick: refresh }, "刷新"));

      return h(
        "div", { className: "wpsc-card" },
        h("div", { className: "wpsc-status" }, dot, h("span", null, statusText)),
        rows,
        h("div", { className: "wpsc-actions" }, actions),
        error ? h("div", { className: "wpsc-err" }, error) : null,
        h("div", { className: "wpsc-hint" }, "普通 WPS 用户即可使用：弹出浏览器 → WPS 账号登录（未登录时自动跳转到 WPS 官方登录页）→ 自动抓取会话并保存到本机 → 通过金山官方 CLI 访问你的云文档。登录会话为高敏感凭证，仅保存在本机令牌文件。"),
      );
    }

    /* ---------------- 云文档浏览面板 ---------------- */
    function WpsCloudPickerModal({ onClose, onPick }) {
      const [authorized, setAuthorized] = react.useState(null); // null=检查中 true/false
      const [crumbs, setCrumbs] = react.useState([{ id: "0", name: "我的云文档" }]);
      const [items, setItems] = react.useState([]);
      const [loading, setLoading] = react.useState(false);
      const [error, setError] = react.useState("");
      const [query, setQuery] = react.useState("");
      const [searching, setSearching] = react.useState(false);
      const [toast, setToast] = react.useState(null);
      const fileInputRef = react.useRef(null);

      const currentId = crumbs.length ? crumbs[crumbs.length - 1].id : "0";

      const toastTimer = react.useRef(null);
      const showToast = react.useCallback((text) => {
        setToast(text);
        if (toastTimer.current) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), 2600);
      }, []);

      const loadItems = react.useCallback(async (parentId) => {
        setLoading(true);
        setError("");
        try {
          const data = await fetchJson(`/wps-oauth/files?parent=${encodeURIComponent(parentId)}`, { cache: "no-store" });
          if (!data.ok) throw new Error(data.error || "加载失败");
          setItems(data.items || []);
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
          setItems([]);
        } finally {
          setLoading(false);
        }
      }, []);

      // 首次打开：检查登录状态
      react.useEffect(() => {
        fetch("/wps-oauth/status", { headers: { accept: "application/json" }, cache: "no-store" })
          .then((r) => r.json())
          .then((data) => {
            setAuthorized(Boolean(data && data.authorized));
            if (data && data.authorized) loadItems("0");
          })
          .catch(() => setAuthorized(false));
        return () => {
          if (toastTimer.current) window.clearTimeout(toastTimer.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const enterFolder = (folder) => {
        setSearching(false);
        setQuery("");
        setCrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
        loadItems(folder.id);
      };
      const goCrumb = (index) => {
        setSearching(false);
        setQuery("");
        setCrumbs((prev) => prev.slice(0, index + 1));
        loadItems(crumbs[index].id);
      };

      const doSearch = async () => {
        const q = query.trim();
        if (!q) return;
        setSearching(true);
        setLoading(true);
        setError("");
        try {
          const data = await fetchJson(`/wps-oauth/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
          if (!data.ok) throw new Error(data.error || "搜索失败");
          setItems(data.items || []);
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
          setItems([]);
        } finally {
          setLoading(false);
        }
      };

      const onUpload = async (file) => {
        if (!file) return;
        setError("");
        try {
          const data = await uploadLocalFile(file);
          if (!data.ok) throw new Error(data.error || "上传失败");
          onPick({
            kind: "local",
            name: data.name,
            path: data.path,
            sizeText: data.size ? formatBytes(data.size) : "",
          });
          onClose();
        } catch (err) {
          setError("上传本地文档失败：" + (err && err.message ? err.message : String(err)));
        }
      };

      const pickFile = async (f) => {
        setError("");
        try {
          const data = await fetchJson(`/wps-oauth/download-attachment?file_id=${encodeURIComponent(f.id)}`, { cache: "no-store" });
          if (!data.ok) throw new Error(data.error || "下载失败");
          onPick({ kind: "cloud", name: data.name, path: data.path, sizeText: data.size ? formatBytes(data.size) : "" });
          onClose();
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          const authIssue = /403|userNotLogin|会话|过期|失效|login/i.test(msg);
          setError(
            authIssue
              ? "登录会话可能已失效，请在设置页点击「退出登录」后重新「登录 WPS 云文档”，再试一次。"
              : "下载云端文件失败：" + msg,
          );
        }
      };

      const body = [];
      if (authorized === null) {
        body.push(h("div", { className: "wpsc-loading", key: "loading" }, "正在检查登录状态…"));
      } else if (authorized === false) {
        body.push(
          h("div", { className: "wpsc-unauth", key: "unauth" },
            h("div", { className: "wpsc-unauth-tip" }, "尚未登录 WPS 云文档。请先在「设置 → WPS 云文档」中完成登录，即可浏览云盘文件。"),
            h("a", {
              className: "wpsc-btn wpsc-btn-primary",
              href: "javascript:void(0)",
              onClick: () => {
                fetch("/wps-oauth/login", { method: "POST" }).catch(() => {});
                showToast("已打开 WPS 网页版登录窗口，请在弹出的浏览器中登录 WPS 账号");
              },
            }, "打开 WPS 登录窗口"),
          ),
        );
      } else {
        if (loading && items.length === 0) {
          body.push(h("div", { className: "wpsc-loading", key: "loading" }, "正在加载…"));
        } else if (items.length === 0) {
          body.push(h("div", { className: "wpsc-empty", key: "empty" }, searching ? "未找到相关文件" : "（此目录为空）"));
        } else {
          const rows = items.map((f, idx) =>
            h("div", {
              className: "wpsc-row-item",
              key: f.id || idx,
              onClick: () => (f.isFolder ? enterFolder(f) : pickFile(f)),
              title: f.isFolder ? "进入文件夹" : "点击：作为附件添加（下载暂存到本机后由 Agent 读取）",
            },
              h("span", { className: "wpsc-item-icon" }, f.isFolder ? h(IconFolder) : h(IconFile)),
              h("span", { className: "wpsc-item-name" }, f.name),
              h("span", { className: "wpsc-item-meta" }, f.isFolder ? "" : f.sizeText + (f.modifiedAt ? " · " + formatTime(f.modifiedAt) : "")),
              h("span", { className: "wpsc-item-open" }, f.isFolder ? "打开" : "读取"),
            ),
          );
          body.push(h("div", { className: "wpsc-list", key: "list" }, rows));
        }
      }

      const crumbNodes = searching
        ? h("div", { className: "wpsc-crumbs" }, "搜索结果：\u201C" + query + "\u201D")
        : h("div", { className: "wpsc-crumbs" },
            crumbs.map((c, idx) => {
              const isLast = idx === crumbs.length - 1;
              const nodes = [];
              if (idx > 0) nodes.push(h("span", { className: "wpsc-crumb-sep", key: "sep" + idx }, "/"));
              nodes.push(
                h("button", {
                  className: "wpsc-crumb" + (isLast ? " wpsc-crumb-cur" : ""),
                  key: "c" + idx,
                  onClick: () => (isLast ? null : goCrumb(idx)),
                }, c.name),
              );
              return nodes;
            }),
          );

      return h(
        "div", { className: "wpsc-overlay", onClick: onClose },
        h(
          "div", { className: "wpsc-panel", onClick: (e) => e.stopPropagation() },
          h("div", { className: "wpsc-panel-head" },
            h("div", { className: "wpsc-panel-title" }, h(IconCloud, { size: 18 }), "WPS 云文档"),
            h("button", { className: "wpsc-close", onClick: onClose, title: "关闭" }, "×"),
          ),
          h("div", { className: "wpsc-toolbar" },
            h("div", { className: "wpsc-search" },
              h("input", {
                value: query,
                placeholder: "搜索云文档…",
                onChange: (e) => setQuery(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter") doSearch();
                },
              }),
              h("button", { className: "wpsc-btn", style: { padding: "3px 10px" }, onClick: doSearch }, "搜索"),
            ),
            h("button", { className: "wpsc-upload-btn", onClick: () => fileInputRef.current && fileInputRef.current.click() }, "上传本地文档"),
            h("input", {
              ref: fileInputRef,
              type: "file",
              style: { display: "none" },
              onChange: (e) => {
                const file = e.target.files && e.target.files[0];
                if (file) onUpload(file);
                e.target.value = "";
              },
            }),
          ),
          crumbNodes,
          body,
          h("div", { className: "wpsc-panel-foot" },
            "点击云端文件或上传本地文档 → 作为附件暂存到本机，Agent 读取讨论（均不上传云端）",
            error ? h("span", { className: "wpsc-err", style: { marginLeft: "auto" } }, error) : null,
          ),
          toast ? h("div", { className: "wpsc-toast" }, toast) : null,
        ),
      );
    }

    /* ---------------- 输入框附件按钮 ---------------- */
    function WpsCloudComposerButton(props) {
      const [open, setOpen] = react.useState(false);
      const inputActions = props.inputActions;

      const onPick = (file) => {
        if (!inputActions || typeof inputActions.setDraft !== "function") {
          return;
        }
        const kindText = file.kind === "cloud" ? "云端文档" : "本地文档";
        inputActions.setDraft(`请读取并讨论我添加的附件《${file.name}》（${kindText}，文件路径：${file.path}）`);
      };

      return h(
        "div", { style: { display: "inline-flex" } },
        h("button", {
          className: "wpsc-composer-btn",
          title: "WPS 云文档：浏览云盘文件或上传本地文档",
          onClick: () => setOpen(true),
          "aria-label": "WPS 云文档附件",
        }, h(IconCloud, { size: 18 })),
        open ? h(WpsCloudPickerModal, { onClose: () => setOpen(false), onPick }) : null,
      );
    }

    /* ---------------- 插件入口 ---------------- */
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.plugin = "@dsh-local/wps-cloud";
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, "wps-cloud: css");

      ctx.slots.inject("settings.section", () => ctx.slots.register(
        { name: "settings.section", id: "wps-cloud", order: 90, label: "WPS 云文档" },
        () => h(WpsSettingsPage),
      ));

      // 对话输入框 + 号左侧的“WPS 云文档”附件图标
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
        { name: "conversation.input.left", kind: "list", id: "wps-cloud", locale: "conversation" },
        WpsCloudComposerButton,
      ));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
