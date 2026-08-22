type LocalAuthRuntime = {
    nodeEnv: string | undefined;
    enabled: string | undefined;
};

const runtimeFromProcess = (): LocalAuthRuntime => ({
    nodeEnv: process.env.NODE_ENV,
    enabled: process.env.LOCAL_AUTH_BYPASS,
});

export function isLocalAuthBypassEnabled(
    headers: Headers,
    runtime: LocalAuthRuntime = runtimeFromProcess(),
) {
    if (runtime.nodeEnv !== "development" || runtime.enabled !== "true") return false;

    const host = headers.get("host")?.trim().toLowerCase();
    if (!host) return false;

    const hostname = host.startsWith("[")
        ? host.slice(0, host.indexOf("]") + 1)
        : host.split(":", 1)[0];

    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
