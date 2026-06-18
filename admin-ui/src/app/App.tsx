import { useEffect, useRef, useState, type FormEvent } from "react";
import { Building2, KeyRound } from "lucide-react";
import { createWWLoginPanel, type WWLoginInstance } from "@wecom/jssdk";
import { AppShell } from "@/layouts/AppShell";
import { useAdminWorkspace } from "@/hooks/useAdminWorkspace";
import { fetchJson } from "@/shared/api";
import type { UserRole } from "@/routes/routes";

type AuthStatus = {
  configured: boolean;
  authenticated: boolean;
  user: string | null;
  role?: UserRole;
  wecomLoginEnabled?: boolean;
};

type WecomLoginUrl = {
  authUrl: string;
};

type WecomPanelConfig = {
  appid: string;
  agentid: string;
  redirectUri: string;
  state: string;
};

function isWecomBrowser(): boolean {
  return /wxwork|micromessenger/i.test(window.navigator.userAgent);
}

function shouldSkipAutoWecomLogin(): boolean {
  return new URLSearchParams(window.location.search).get("skip_auto_wecom") === "1";
}

function LoginView({ onAuthenticated, wecomLoginEnabled }: { onAuthenticated: () => void; wecomLoginEnabled?: boolean }) {
  const [loginMode, setLoginMode] = useState<"wecom" | "password">(wecomLoginEnabled ? "wecom" : "password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(wecomLoginEnabled ? "使用企业微信扫码进入管理台。" : "请输入账号后继续。");
  const [wecomAuthUrl, setWecomAuthUrl] = useState<string | null>(null);
  const [wecomBusy, setWecomBusy] = useState(false);
  const [wecomRefreshKey, setWecomRefreshKey] = useState(0);
  const wecomPanelRef = useRef<HTMLDivElement | null>(null);
  const wecomPanelInstanceRef = useRef<WWLoginInstance | null>(null);

  useEffect(() => {
    if (wecomLoginEnabled) {
      setLoginMode("wecom");
      setMessage("使用企业微信扫码进入管理台。");
    } else {
      setLoginMode("password");
      setMessage("请输入账号后继续。");
    }
  }, [wecomLoginEnabled]);

  useEffect(() => {
    if (!wecomLoginEnabled || !isWecomBrowser() || shouldSkipAutoWecomLogin()) {
      return;
    }
    setMessage("正在通过企业微信自动登录。");
    window.location.href = "/_gateway/auth/wecom/oauth/start";
  }, [wecomLoginEnabled]);

  useEffect(() => {
    if (!wecomLoginEnabled || loginMode !== "wecom") {
      return;
    }

    let cancelled = false;
    wecomPanelInstanceRef.current?.unmount();
    wecomPanelInstanceRef.current = null;
    if (wecomPanelRef.current) {
      wecomPanelRef.current.innerHTML = "";
    }
    setWecomBusy(true);
    setMessage("正在准备企业微信快捷登录。");
    fetchJson<WecomPanelConfig>("/_gateway/auth/wecom/panel-config")
      .then((config) => {
        if (cancelled) {
          return;
        }
        if (!wecomPanelRef.current) {
          throw new Error("登录组件容器未就绪。");
        }
        wecomPanelInstanceRef.current = createWWLoginPanel({
          el: wecomPanelRef.current,
          params: {
            login_type: "CorpApp",
            appid: config.appid,
            agentid: config.agentid,
            redirect_uri: config.redirectUri,
            state: config.state,
            redirect_type: "callback",
            panel_size: "small",
            lang: "zh",
          },
          onLoginSuccess({ code }) {
            setMessage("企业微信授权成功，正在登录。");
            fetchJson<{ ok: boolean; user: string }>("/_gateway/auth/wecom/panel-login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code }),
            })
              .then(() => {
                setMessage("登录成功，正在进入管理台。");
                onAuthenticated();
              })
              .catch((error) => {
                setMessage(error instanceof Error ? error.message : "企业微信登录失败。");
              });
          },
          onLoginFail(error) {
            setMessage(error.errMsg || `企业微信登录失败: ${error.errCode}`);
          },
        });
        setMessage("请使用企业微信扫码登录。");
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setMessage(error instanceof Error ? error.message : "企业微信快捷登录加载失败。");
        fetchJson<WecomLoginUrl>("/_gateway/auth/wecom/url")
          .then((result) => {
            if (!cancelled) {
              setWecomAuthUrl(result.authUrl);
              setMessage("请使用企业微信扫码登录。");
            }
          })
          .catch((fallbackError) => {
            if (!cancelled) {
              setWecomAuthUrl(null);
              setMessage(fallbackError instanceof Error ? fallbackError.message : "企业微信二维码加载失败。");
            }
          });
      })
      .finally(() => {
        if (!cancelled) {
          setWecomBusy(false);
        }
      });

    return () => {
      cancelled = true;
      wecomPanelInstanceRef.current?.unmount();
      wecomPanelInstanceRef.current = null;
    };
  }, [loginMode, onAuthenticated, wecomLoginEnabled, wecomRefreshKey]);

  useEffect(() => {
    if (!wecomLoginEnabled || loginMode !== "wecom") {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "azt-wecom-login-success") {
        return;
      }
      setMessage("登录成功，正在进入管理台。");
      if (typeof event.data.completeUrl === "string") {
        window.location.href = event.data.completeUrl;
        return;
      }
      onAuthenticated();
    };
    window.addEventListener("message", handleMessage);

    const timer = window.setInterval(() => {
      fetchJson<AuthStatus>("/_gateway/auth/status")
        .then((status) => {
          if (status.authenticated) {
            setMessage("登录成功，正在进入管理台。");
            onAuthenticated();
          }
        })
        .catch(() => undefined);
    }, 1800);

    return () => {
      window.removeEventListener("message", handleMessage);
      window.clearInterval(timer);
    };
  }, [loginMode, onAuthenticated, wecomLoginEnabled]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("正在登录...");
    try {
      await fetchJson<{ ok: boolean; user: string }>("/_gateway/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      setMessage("登录成功。");
      onAuthenticated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="auth-panel" onSubmit={handleSubmit}>
        <div className="auth-mark">AI Zero Token</div>
        <h1>管理访问</h1>
        <p>{message}</p>
        {wecomLoginEnabled ? (
          <div className="auth-mode-switch" role="tablist" aria-label="登录方式">
            <button
              className={loginMode === "wecom" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={loginMode === "wecom"}
              onClick={() => {
                setLoginMode("wecom");
                setMessage("使用企业微信扫码进入管理台。");
              }}
            >
              扫码登录
            </button>
            <button
              className={loginMode === "password" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={loginMode === "password"}
              onClick={() => {
                setLoginMode("password");
                setMessage("请输入账号后继续。");
              }}
            >
              密码登录
            </button>
          </div>
        ) : null}
        {loginMode === "wecom" && wecomLoginEnabled ? (
          <div className="wecom-login-panel">
            <div className="wecom-login-icon" aria-hidden="true">
              <Building2 size={28} />
            </div>
            <div className="wecom-qr-frame-wrap">
              <div ref={wecomPanelRef} className="wecom-login-component" />
              {wecomAuthUrl ? (
                <iframe className="wecom-qr-frame" title="企业微信扫码登录" src={wecomAuthUrl} />
              ) : !wecomPanelInstanceRef.current ? (
                <div className="wecom-qr-placeholder">{wecomBusy ? "二维码加载中..." : "二维码暂不可用"}</div>
              ) : null}
            </div>
            <button
              className="wecom-login-button"
              type="button"
              disabled={wecomBusy}
              onClick={() => {
                setWecomAuthUrl(null);
                setWecomRefreshKey((current) => current + 1);
              }}
            >
              刷新二维码
            </button>
            <button
              className="auth-link-button"
              type="button"
              onClick={() => {
                setLoginMode("password");
                setMessage("请输入账号后继续。");
              }}
            >
              使用账号密码登录
            </button>
          </div>
        ) : (
          <>
            <label>
              用户名
              <input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="admin"
                required
              />
            </label>
            <label>
              密码
              <input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="请输入密码"
                required
              />
            </label>
            <button className="primary-action" type="submit" disabled={busy}>
              {busy ? "登录中..." : "登录"}
            </button>
            {wecomLoginEnabled ? (
              <button
                className="auth-link-button"
                type="button"
                onClick={() => {
                  setLoginMode("wecom");
                  setMessage("使用企业微信扫码进入管理台。");
                }}
              >
                <KeyRound size={16} />
                切换为企业微信扫码登录
              </button>
            ) : null}
          </>
        )}
      </form>
    </main>
  );
}

function AuthenticatedApp({ auth }: { auth: AuthStatus }) {
  const workspace = useAdminWorkspace({ currentUser: auth.user, role: auth.role });
  return <AppShell workspace={workspace} />;
}

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  async function refreshAuth() {
    try {
      setAuth(await fetchJson<AuthStatus>("/_gateway/auth/status"));
      setAuthError(null);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "无法读取认证状态。");
    }
  }

  useEffect(() => {
    refreshAuth().catch(() => undefined);
  }, []);

  if (authError) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <div className="auth-mark">AI Zero Token</div>
          <h1>访问禁止</h1>
          <p>{authError}</p>
        </section>
      </main>
    );
  }

  if (!auth) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <div className="auth-mark">AI Zero Token</div>
          <h1>正在检查访问权限</h1>
          <p>请稍候。</p>
        </section>
      </main>
    );
  }

  if (!auth.configured) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <div className="auth-mark">AI Zero Token</div>
          <h1>访问未启用</h1>
          <p>请先在服务端设置 AZT_ADMIN_USER、AZT_ADMIN_PASSWORD 和 AZT_SESSION_SECRET。</p>
        </section>
      </main>
    );
  }

  if (!auth.authenticated) {
    return <LoginView onAuthenticated={refreshAuth} wecomLoginEnabled={auth.wecomLoginEnabled} />;
  }

  return <AuthenticatedApp auth={auth} />;
}
