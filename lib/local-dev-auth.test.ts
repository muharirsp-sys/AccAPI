import assert from "node:assert/strict";
import test from "node:test";

import { isLocalAuthBypassEnabled } from "./local-dev-auth";

const development = { nodeEnv: "development", enabled: "true" };

test("local auth bypass accepts only explicit development loopback requests", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
        assert.equal(isLocalAuthBypassEnabled(new Headers({ host }), development), true, host);
    }
});

test("local auth bypass fails closed outside its exact boundary", () => {
    const denied = [
        [new Headers({ host: "localhost:3000" }), { nodeEnv: "production", enabled: "true" }],
        [new Headers({ host: "localhost:3000" }), { nodeEnv: "development", enabled: undefined }],
        [new Headers({ host: "localhost.evil:3000" }), development],
        [new Headers({ host: "192.168.1.10:3000" }), development],
        [new Headers(), development],
    ] as const;

    for (const [headers, runtime] of denied) {
        assert.equal(isLocalAuthBypassEnabled(headers, runtime), false);
    }
});
