import { describe, expect, it } from "vitest";
import { HOST_KEY_UNKNOWN } from "../hostKey";
import { hostKeyTarget } from "./hostKeyTarget";

/**
 * The trust dialog has to open on the machine whose key `ssh` did not know — which, behind a jump
 * host, is often not the one the row names. And a changed key must never open it at all.
 */

const row = { host: "web-01.example.com", port: 2222, user: "deploy" };
const unknown = (named: string) =>
  `${HOST_KEY_UNKNOWN}: ${named} isn't in your known_hosts file, so ssh refused to connect.`;

describe("hostKeyTarget", () => {
  it("reads the host and port ssh named, with the row's user when it is the row's machine", () => {
    expect(hostKeyTarget(unknown("[web-01.example.com]:2222"), row)).toEqual({
      host: "web-01.example.com",
      port: 2222,
      user: "deploy",
    });
  });

  it("opens on the bastion when that is the key ssh did not know, as ~/.ssh/config reaches it", () => {
    expect(hostKeyTarget(unknown("bastion.example.com"), row)).toEqual({
      host: "bastion.example.com",
      port: 0,
      user: "",
    });
  });

  it("falls back to the row's address when ssh named no host", () => {
    expect(hostKeyTarget(`${HOST_KEY_UNKNOWN}: isn't named here`, row)).toEqual(row);
  });

  it("offers nothing for a changed key or any other failure", () => {
    expect(hostKeyTarget("SSH host key has changed: web-01.example.com presented a different key", row)).toBeNull();
    expect(hostKeyTarget("Permission denied (publickey).", row)).toBeNull();
  });
});
