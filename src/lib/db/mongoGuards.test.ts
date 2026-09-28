import { describe, expect, it } from "vitest";
import { destructiveMongoCommand, destructiveMongoCommands } from "./mongoGuards";
import { splitStatements } from "./statements";

describe("destructiveMongoCommand", () => {
  it("asks about a write aimed at every document", () => {
    expect(destructiveMongoCommand("db.users.deleteMany({})")).toEqual({ operation: "deleteMany", target: "users" });
    expect(destructiveMongoCommand("db.users.deleteMany( { } );")).toEqual({ operation: "deleteMany", target: "users" });
    expect(destructiveMongoCommand("db.users.remove({})")).toEqual({ operation: "remove", target: "users" });
    expect(destructiveMongoCommand("db.users.updateMany({}, {$set: {a: 1}})")).toEqual({
      operation: "updateMany",
      target: "users",
    });
    expect(destructiveMongoCommand("db.getCollection('odd name').deleteMany({})")).toEqual({
      operation: "deleteMany",
      target: "odd name",
    });
  });

  it("leaves a write with a real filter alone", () => {
    expect(destructiveMongoCommand("db.users.deleteMany({status: 'old'})")).toBeNull();
    expect(destructiveMongoCommand("db.users.updateMany({a: 1}, {$set: {b: 2}})")).toBeNull();
    expect(destructiveMongoCommand("db.users.deleteOne({})")).toBeNull();
    expect(destructiveMongoCommand("db.users.find({})")).toBeNull();
  });

  it("treats remove({}, justOne) as the one document it removes", () => {
    expect(destructiveMongoCommand("db.users.remove({}, true)")).toBeNull();
    expect(destructiveMongoCommand("db.users.remove({}, {justOne: true})")).toBeNull();
    expect(destructiveMongoCommand("db.users.remove({}, false)")).toEqual({ operation: "remove", target: "users" });
  });

  it("asks about dropping a collection or a database", () => {
    expect(destructiveMongoCommand("db.users.drop()")).toEqual({ operation: "drop", target: "users" });
    expect(destructiveMongoCommand("db.dropDatabase()")).toEqual({ operation: "dropDatabase", target: "" });
    expect(destructiveMongoCommand("{dropDatabase: 1}")).toEqual({ operation: "dropDatabase", target: "" });
    expect(destructiveMongoCommand("db.runCommand({ drop: 'users' })")).toEqual({ operation: "drop", target: "users" });
    expect(destructiveMongoCommand('{"drop": "users"}')).toEqual({ operation: "drop", target: "users" });
  });

  it("reads the raw delete command behind deleteMany", () => {
    expect(destructiveMongoCommand("{delete: 'users', deletes: [{q: {}, limit: 0}]}")).toEqual({
      operation: "delete",
      target: "users",
    });
    expect(destructiveMongoCommand("{delete: 'users', deletes: [{q: {a: 1}, limit: 0}]}")).toBeNull();
  });
});

describe("destructiveMongoCommands", () => {
  it("finds each destructive statement in a buffer, split the way the driver splits it", () => {
    const buffer = "db.users.find({})\n\ndb.users.drop()\n\ndb.logs.deleteMany({})";
    expect(destructiveMongoCommands(splitStatements(buffer, "javascript"))).toEqual([
      { operation: "drop", target: "users" },
      { operation: "deleteMany", target: "logs" },
    ]);
  });
});
