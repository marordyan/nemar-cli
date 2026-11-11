/**
 * The OpenID Foundation conformance suite's plan configurations for the NEMAR provider (epic #2014
 * phase #2020), as pure functions of the rig's addresses and the throwaway client credentials the rig
 * has just registered.
 *
 * Two plans run: the configuration plan (`oidcc-config-certification-test-plan`, no browser), and the
 * Basic plan (`oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=
 * static_client]`), whose scripted browser (HtmlUnit) signs in and consents through the rig's pages.
 *
 * The browser vocabulary is the suite's: `click`, `text`, `wait`; elements by `id`, `name`, `xpath`,
 * `css`; a task runs for a page whose address matches its pattern, and an `optional` task is skipped
 * when no such page appears. A command that ends in `update-image-placeholder` stands in for the
 * screenshot a human certifier would upload.
 *
 * A third shape, for the deployed development system (`buildDevBasicPlanConfig`), points the same plan at
 * the REAL pages: the issuer is the development API and the authorization endpoint is the staging
 * website's own page, so the issuer and the page are on different hosts. Only modules that need no
 * sign-in can run there unattended (the suite's browser cannot sign in on the real page, which asks for a
 * code mailed to the person), so the browser script is just the completion check and
 * `oidcc-ensure-request-with-valid-pkce-succeeds`, the one module that signs in, is left out of the plan
 * ({@link devBasicPlanArgument}). The modules that run stop before the token endpoint, so the client
 * secret in the configuration is never used and is {@link DUMMY_CLIENT_SECRET}.
 *
 * A configuration holds the throwaway clients' secrets, so the rig writes it to a directory that is never
 * uploaded. (The logs and results that ARE uploaded also show such secrets and codes, which die with the
 * rig's in-memory database when the job ends.)
 */

/** The text each stand-in page shows, which the suite's `wait` commands look for. */
export const RIG_TEXT = {
  signIn: "Sign in to NEMAR",
  redirectNotRegistered: "has not registered",
} as const;

/** The test e-mail account the rig seeds; the `.test` domain makes the sign-in code echo outside production. */
export const RIG_ACCOUNT_EMAIL = "conformance@nemar.test";

export interface PlanAddresses {
  /** The provider's issuer and the rig's own origin: `https://rig.example.org:9443`. */
  readonly issuer: string;
  /**
   * The origin of the authorization page, when it is not the issuer's (the deployed development system
   * serves it from the website). Defaults to the issuer, as on the rig.
   */
  readonly authorizationBase?: string;
  /** The suite's alias, which fixes its callback address: `<suite>/test/a/<alias>/callback`. */
  readonly alias: string;
}

export interface ClientCredentials {
  readonly client_id: string;
  readonly client_secret: string;
}

type Command = Array<string | number>;
interface Task {
  task: string;
  optional?: boolean;
  match?: string;
  commands?: Command[];
}
interface BrowserBlock {
  comment?: string;
  match: string;
  tasks: Task[];
}

/** The redirect address a suite with this alias sends the browser back to. */
export function callbackAddress(suiteOrigin: string, alias: string): string {
  return `${suiteOrigin.replace(/\/+$/, "")}/test/a/${alias}/callback`;
}

function loginTask(issuer: string, withPlaceholder: boolean): Task {
  const commands: Command[] = [];
  if (withPlaceholder) {
    commands.push([
      "wait",
      "xpath",
      "//*",
      10,
      RIG_TEXT.signIn,
      "update-image-placeholder-optional",
    ]);
  }
  commands.push(
    ["text", "name", "email", RIG_ACCOUNT_EMAIL, "optional"],
    ["click", "id", "signin"],
  );
  return { task: "Login", optional: true, match: `${issuer}/login*`, commands };
}

function consentTask(issuer: string): Task {
  // The Deny button comes first on the page, so the Allow button is chosen by its value.
  return {
    task: "Consent",
    optional: true,
    match: `${issuer}/oauth/authorize*`,
    commands: [["click", "xpath", "//button[@value='allow']"]],
  };
}

const verifyComplete: Task = {
  task: "Verify Complete",
  match: "*/test/*/callback*",
  commands: [["wait", "id", "submission_complete", 10]],
};

function standardBrowser(issuer: string, withPlaceholder = false): BrowserBlock[] {
  return [
    {
      match: `${issuer}/oauth/authorize*`,
      tasks: [loginTask(issuer, withPlaceholder), consentTask(issuer), verifyComplete],
    },
  ];
}

/** The browser script for a test that expects NEMAR's error page for an unregistered redirect address. */
function redirectErrorBrowser(base: string): BrowserBlock[] {
  return [
    {
      comment: "expect an immediate error page",
      match: `${base}/oauth/authorize*`,
      tasks: [
        {
          task: "Expect redirect uri mismatch error page",
          match: `${base}/oauth/authorize*`,
          commands: [
            [
              "wait",
              "xpath",
              "//*",
              10,
              RIG_TEXT.redirectNotRegistered,
              "update-image-placeholder",
            ],
          ],
        },
      ],
    },
  ];
}

/** The configuration plan reads the discovery document and nothing else: no client, no browser. */
export function buildConfigPlanConfig(addr: PlanAddresses): Record<string, unknown> {
  return {
    alias: `${addr.alias}-config`,
    description: "NEMAR OpenID Connect provider: configuration",
    server: { discoveryUrl: `${addr.issuer}/.well-known/openid-configuration` },
  };
}

/** The Basic plan: the static clients, the scripted sign-in and consent, and the four overrides. */
export function buildBasicPlanConfig(
  addr: PlanAddresses,
  clients: {
    client: ClientCredentials;
    client2: ClientCredentials;
    /** The client the suite's client_secret_post module reads (`client_secret_post` in the plan). */
    clientPost: ClientCredentials;
  },
): Record<string, unknown> {
  const { issuer } = addr;
  return {
    alias: addr.alias,
    description: "NEMAR OpenID Connect provider: Basic profile",
    server: { discoveryUrl: `${issuer}/.well-known/openid-configuration` },
    client: { ...clients.client },
    client2: { ...clients.client2 },
    client_secret_post: { ...clients.clientPost },
    browser: standardBrowser(issuer),
    override: {
      // Both sign in a second time; the sign-in page is what a certifier would screenshot.
      "oidcc-prompt-login": { browser: standardBrowser(issuer, true) },
      "oidcc-max-age-1": { browser: standardBrowser(issuer, true) },
      // An unregistered redirect address is an error page, never a redirect. The second test passes the
      // address through a request object and expects the same page.
      "oidcc-ensure-registered-redirect-uri": { browser: redirectErrorBrowser(issuer) },
      "oidcc-ensure-request-object-with-redirect-uri": { browser: redirectErrorBrowser(issuer) },
    },
  };
}

/** The plan name and variants of the Basic run, as the suite's command line spells them. */
export const BASIC_PLAN_NAME =
  "oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]";

/** The 35 modules of that plan, in the suite's order (read from a run's own list). */
export const BASIC_PLAN_MODULES = [
  "oidcc-server",
  "oidcc-response-type-missing",
  "oidcc-userinfo-get",
  "oidcc-userinfo-post-header",
  "oidcc-userinfo-post-body",
  "oidcc-ensure-request-without-nonce-succeeds-for-code-flow",
  "oidcc-scope-profile",
  "oidcc-scope-email",
  "oidcc-scope-address",
  "oidcc-scope-phone",
  "oidcc-scope-all",
  "oidcc-alternate-happy-flow",
  "oidcc-display-page",
  "oidcc-display-popup",
  "oidcc-prompt-login",
  "oidcc-prompt-none-not-logged-in",
  "oidcc-prompt-none-logged-in",
  "oidcc-max-age-1",
  "oidcc-max-age-10000",
  "oidcc-ensure-request-with-unknown-parameter-succeeds",
  "oidcc-id-token-hint",
  "oidcc-login-hint",
  "oidcc-ui-locales",
  "oidcc-claims-locales",
  "oidcc-ensure-request-with-acr-values-succeeds",
  "oidcc-codereuse",
  "oidcc-codereuse-30seconds",
  "oidcc-ensure-registered-redirect-uri",
  "oidcc-ensure-post-request-succeeds",
  "oidcc-server-client-secret-post",
  "oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported",
  "oidcc-claims-essential",
  "oidcc-ensure-request-object-with-redirect-uri",
  "oidcc-refresh-token",
  "oidcc-ensure-request-with-valid-pkce-succeeds",
] as const;

/** The one module that signs a person in; the real page's sign-in cannot be scripted, so a dev run skips it. */
export const SIGN_IN_MODULE = "oidcc-ensure-request-with-valid-pkce-succeeds";

/** The modules a run against the deployed pages selects: all of them but {@link SIGN_IN_MODULE}. */
export const DEV_BASIC_PLAN_MODULES: readonly string[] = BASIC_PLAN_MODULES.filter(
  (m) => m !== SIGN_IN_MODULE,
);

/**
 * The Basic plan as a command-line argument for a run against the deployed pages: the plan, its variants,
 * then `:` and the selected modules (the suite's own `plan[variants]:module,module` syntax).
 */
export function devBasicPlanArgument(): string {
  return `${BASIC_PLAN_NAME}:${DEV_BASIC_PLAN_MODULES.join(",")}`;
}

/**
 * The client secret in a development plan configuration. It is a fixed, plainly fake string: the modules
 * that run stop at the authorization endpoint and never authenticate to the token endpoint, so the real
 * secret is never needed and never held.
 */
export const DUMMY_CLIENT_SECRET = "not-a-real-secret-never-sent-anywhere";

/**
 * The Basic plan for the deployed development system. One registered client stands for all three the
 * suite reads (`client`, `client2`, `client_secret_post`), the browser script is only the completion
 * check, and the two redirect-address modules wait for the real page's error text.
 */
export function buildDevBasicPlanConfig(
  addr: PlanAddresses,
  clientId: string,
): Record<string, unknown> {
  const base = addr.authorizationBase ?? addr.issuer;
  const client = { client_id: clientId, client_secret: DUMMY_CLIENT_SECRET };
  return {
    alias: addr.alias,
    description: "NEMAR OpenID Connect provider: Basic profile (deployed development system)",
    server: { discoveryUrl: `${addr.issuer}/.well-known/openid-configuration` },
    client: { ...client },
    client2: { ...client },
    client_secret_post: { ...client },
    browser: [{ match: `${base}/oauth/authorize*`, tasks: [verifyComplete] }],
    override: {
      "oidcc-ensure-registered-redirect-uri": { browser: redirectErrorBrowser(base) },
      "oidcc-ensure-request-object-with-redirect-uri": { browser: redirectErrorBrowser(base) },
    },
  };
}
