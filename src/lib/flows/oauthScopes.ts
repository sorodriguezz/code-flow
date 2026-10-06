/**
 * What a new OAuth 2 credential asks for, per provider — everything the Google and Microsoft nodes
 * and Graph calls need; a person narrows it before connecting. Shared by the credentials dialog and
 * the "connect" box a node shows when it has no credential yet.
 */
export const OAUTH_SCOPES: Record<string, string> = {
  google:
    "openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive",
  // Mail.ReadWrite, not Mail.Read: the Microsoft 365 node marks mail read and moves it.
  microsoft: "openid email offline_access User.Read Mail.Send Mail.ReadWrite Calendars.ReadWrite Files.ReadWrite",
  custom: "",
};

/** Where a person registers the OAuth client a credential signs in with. */
export const OAUTH_CONSOLE: Record<"google" | "microsoft", string> = {
  google: "https://console.cloud.google.com/apis/credentials",
  microsoft: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
};
