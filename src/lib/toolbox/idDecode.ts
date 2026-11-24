/**
 * Ids that carry the moment they were made: a MongoDB ObjectId (seconds in its first four bytes)
 * and a Snowflake (milliseconds since a service's own epoch in its top 42 bits). Reading the date
 * back out is the usual question — «when was this record created?» — without the database.
 */

export interface SnowflakeEpoch {
  id: string;
  label: string;
  /** Unix ms the service counts from. */
  epoch: number;
  /** Bits for worker / process / sequence, low to high: Twitter's layout unless said otherwise. */
  layout: "twitter" | "discord" | "instagram";
}

export const SNOWFLAKE_EPOCHS: SnowflakeEpoch[] = [
  { id: "twitter", label: "Twitter / X", epoch: 1288834974657, layout: "twitter" },
  { id: "discord", label: "Discord", epoch: 1420070400000, layout: "discord" },
  { id: "instagram", label: "Instagram", epoch: 1314220021721, layout: "instagram" },
  { id: "unix", label: "Unix (0)", epoch: 0, layout: "twitter" },
];

export type DecodedId =
  | { kind: "objectId"; date: Date; machine: string; process: string; counter: number }
  | { kind: "snowflake"; date: Date; fields: [string, number][] }
  | { kind: "ulid"; date: Date; randomness: string };

const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function decodeId(raw: string, epoch: SnowflakeEpoch): DecodedId {
  const text = raw.trim();
  if (/^[0-9a-f]{24}$/i.test(text)) {
    return {
      kind: "objectId",
      date: new Date(parseInt(text.slice(0, 8), 16) * 1000),
      // The 2018+ driver spec calls bytes 4–8 one random value; older ones split it into machine and
      // process, which is still what most ids in the wild were made with.
      machine: text.slice(8, 14),
      process: text.slice(14, 18),
      counter: parseInt(text.slice(18), 16),
    };
  }
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(text)) {
    let ms = 0;
    for (const char of text.slice(0, 10).toUpperCase()) ms = ms * 32 + ULID.indexOf(char);
    return { kind: "ulid", date: new Date(ms), randomness: text.slice(10) };
  }
  if (/^\d{1,20}$/.test(text)) {
    const id = BigInt(text);
    if (id >= 1n << 64n) throw new Error("A Snowflake is 64 bits; this number is larger");
    const ms = Number(id >> 22n) + epoch.epoch;
    const fields: [string, number][] =
      epoch.layout === "discord"
        ? [["worker", Number((id >> 17n) & 31n)], ["process", Number((id >> 12n) & 31n)], ["increment", Number(id & 4095n)]]
        : epoch.layout === "instagram"
          ? [["shard", Number((id >> 10n) & 8191n)], ["sequence", Number(id & 1023n)]]
          : [["datacenter", Number((id >> 17n) & 31n)], ["worker", Number((id >> 12n) & 31n)], ["sequence", Number(id & 4095n)]];
    // Instagram packs 41 bits of time over 13 of shard and 10 of sequence, so its time sits 23 up.
    const date = new Date(epoch.layout === "instagram" ? Number(id >> 23n) + epoch.epoch : ms);
    return { kind: "snowflake", date, fields };
  }
  throw new Error("Not an ObjectId (24 hex characters), a ULID (26 characters) or a Snowflake (a number)");
}
