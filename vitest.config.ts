import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const TEST_API_SECRET = "nscf-test-secret-20260717";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          API_SECRET: TEST_API_SECRET,
          AUTH_DEFAULT_ROLES: "readable",
          AUTH_FAIL_DELAY: "1",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
