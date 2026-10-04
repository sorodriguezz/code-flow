import { describe, expect, it } from "vitest";
import { liftUrlSecret, maskConnectionSecrets, urlCarriesPassword } from "./connectionSecrets";

describe("liftUrlSecret", () => {
  it("lifts a password out of any JDBC driver's URL, in the shape that driver writes it", () => {
    expect(liftUrlSecret("jdbc", "jdbc:snowflake://acme.snowflakecomputing.com/?user=me&password=s3cret&db=SALES")).toEqual({
      url: "jdbc:snowflake://acme.snowflakecomputing.com/?user=me&db=SALES",
      password: "s3cret",
      user: null,
    });
    expect(liftUrlSecret("jdbc", "jdbc:db2://h:50000/SAMPLE:user=db2inst1;password=pw;")).toEqual({
      url: "jdbc:db2://h:50000/SAMPLE:user=db2inst1;",
      password: "pw",
      user: null,
    });
    expect(
      liftUrlSecret("jdbc", "jdbc:databricks://h:443/default;transportMode=http;AuthMech=3;UID=token;PWD=dapi123").url,
    ).toBe("jdbc:databricks://h:443/default;transportMode=http;AuthMech=3;UID=token");
    expect(liftUrlSecret("jdbc", "jdbc:mariadb://app:pw@h:3306/db").url).toBe("jdbc:mariadb://app@h:3306/db");
    expect(liftUrlSecret("jdbc", "jdbc:oracle:thin:scott/tiger@h:1521/orcl")).toEqual({
      url: "jdbc:oracle:thin:@h:1521/orcl",
      password: "tiger",
      user: "scott",
    });
    // The address of an Athena URL has an `=` in it, and is still not a pair.
    expect(liftUrlSecret("jdbc", "jdbc:athena://Region=us-east-1;WorkGroup=primary").password).toBeNull();
  });

  it("lifts a URI's password and keeps the user", () => {
    expect(liftUrlSecret("postgres", "postgresql://app:s3cret@db.example.com:5432/shop?sslmode=require")).toEqual({
      url: "postgresql://app@db.example.com:5432/shop?sslmode=require",
      password: "s3cret",
      user: null,
    });
    expect(liftUrlSecret("mysql", "mysql://root:pw@db.example.com:3306/app").url).toBe("mysql://root@db.example.com:3306/app");
    expect(liftUrlSecret("mongodb", "mongodb+srv://u:p@cluster.example.net/app").password).toBe("p");
  });

  it("reads Supabase's placeholder shape, which is the one people paste", () => {
    const lifted = liftUrlSecret(
      "supabase",
      "postgresql://postgres.abcd:pa55@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
    );
    expect(lifted.password).toBe("pa55");
    expect(lifted.url).toBe("postgresql://postgres.abcd@aws-0-eu-west-1.pooler.supabase.com:6543/postgres");
  });

  it("percent-decodes, because the driver would have and the keychain value is used verbatim", () => {
    expect(liftUrlSecret("postgres", "postgres://u:p%40ss%2Fw@db.example.com/x").password).toBe("p@ss/w");
  });

  it("splits at the last @, where a host cannot be", () => {
    const lifted = liftUrlSecret("postgres", "postgresql://user:pass@@db.example.com:5432/postgres");
    expect(lifted.password).toBe("pass@");
    expect(lifted.url).toBe("postgresql://user@db.example.com:5432/postgres");
  });

  it("drops the whole userinfo when there is no user, as Redis writes it", () => {
    expect(liftUrlSecret("redis", "rediss://:tok@cache.example.com:6380/0")).toEqual({
      url: "rediss://cache.example.com:6380/0",
      password: "tok",
      user: null,
    });
    expect(liftUrlSecret("redis", "rediss://default:tok@cache.example.com:6380/0").url).toBe(
      "rediss://default@cache.example.com:6380/0",
    );
  });

  it("lifts Postgres' query parameter and keyword forms", () => {
    expect(liftUrlSecret("postgres", "postgres://u@db.example.com/x?password=abc&sslmode=require")).toEqual({
      url: "postgres://u@db.example.com/x?sslmode=require",
      password: "abc",
      user: null,
    });
    expect(liftUrlSecret("postgres", "host=db.example.com password='it\\'s' user=app")).toEqual({
      url: "host=db.example.com user=app",
      password: "it's",
      user: null,
    });
  });

  it("finds SQL Server's Password and Pwd, quoted or not", () => {
    expect(liftUrlSecret("sqlserver", "Server=db.example.com,1433;Database=app;User Id=sa;Password=S3cr3t!;Encrypt=true")).toEqual({
      url: "Server=db.example.com,1433;Database=app;User Id=sa;Encrypt=true",
      password: "S3cr3t!",
      user: null,
    });
    expect(liftUrlSecret("sqlserver", "Server=h;UID=sa;pwd = \"a;b\"").password).toBe("a;b");
    expect(liftUrlSecret("sqlserver", "Server=h;UID=sa;Pwd='it''s'").password).toBe("it's");
    expect(liftUrlSecret("sqlserver", "Server=h;Password={x;y}").password).toBe("x;y");
  });

  it("finds a JDBC SQL Server password without taking the server for a pair", () => {
    expect(liftUrlSecret("sqlserver", "jdbc:sqlserver://db.example.com:1433;databaseName=app;user=sa;password={p;w}")).toEqual({
      url: "jdbc:sqlserver://db.example.com:1433;databaseName=app;user=sa",
      password: "p;w",
      user: null,
    });
  });

  it("moves Oracle's user to the field, since user@host is not a URL its driver reads", () => {
    expect(liftUrlSecret("oracle", "jdbc:oracle:thin:scott/tiger@//db.example.com:1521/FREEPDB1")).toEqual({
      url: "jdbc:oracle:thin:@//db.example.com:1521/FREEPDB1",
      password: "tiger",
      user: "scott",
    });
    expect(liftUrlSecret("oracle", "scott/tiger@db.example.com:1521/FREEPDB1")).toEqual({
      url: "db.example.com:1521/FREEPDB1",
      password: "tiger",
      user: "scott",
    });
  });

  it("leaves a URL with no password exactly as it was", () => {
    for (const [kind, url] of [
      ["postgres", "postgres://app@db.example.com/x"],
      ["postgres", "postgres://app:@db.example.com/x"],
      ["sqlserver", "Server=h;User Id=sa;Encrypt=true"],
      ["oracle", "db.example.com:1521/FREEPDB1"],
      ["iris", "jdbc:IRIS://db.example.com:1972/USER"],
      ["sqlite", "sqlite:///tmp/app.db"],
      ["mysql", ""],
    ] as const) {
      expect(liftUrlSecret(kind, url), `${kind} ${url}`).toEqual({ url, password: null, user: null });
      expect(urlCarriesPassword(kind, url)).toBe(false);
    }
  });

  it("is idempotent: lifting what was already lifted finds nothing", () => {
    const once = liftUrlSecret("sqlserver", "Server=h;Password=x;Database=d");
    expect(liftUrlSecret("sqlserver", once.url).password).toBeNull();
    const uri = liftUrlSecret("mongodb", "mongodb://u:p@h/db");
    expect(liftUrlSecret("mongodb", uri.url).password).toBeNull();
  });
});

describe("maskConnectionSecrets", () => {
  it("masks every shape a password comes in, whatever the engine", () => {
    expect(maskConnectionSecrets("postgresql://app:s3cret@db.example.com/x")).toBe("postgresql://app:••••@db.example.com/x");
    expect(maskConnectionSecrets("Server=h;User Id=sa;Password=S3cr3t;Encrypt=true")).toBe(
      "Server=h;User Id=sa;Password=••••;Encrypt=true",
    );
    expect(maskConnectionSecrets("Server=h;PWD=\"a;b\";Database=x")).toBe("Server=h;PWD=••••;Database=x");
    expect(maskConnectionSecrets("jdbc:sqlserver://h;password={p;w};user=sa")).toBe("jdbc:sqlserver://h;password=••••;user=sa");
    expect(maskConnectionSecrets("postgres://u@h/x?sslmode=require&password=abc")).toBe(
      "postgres://u@h/x?sslmode=require&password=••••",
    );
    expect(maskConnectionSecrets("host=h password=secret user=u")).toBe("host=h password=•••• user=u");
    expect(maskConnectionSecrets("jdbc:oracle:thin:scott/tiger@//h:1521/svc")).toBe("jdbc:oracle:thin:scott/••••@//h:1521/svc");
  });

  it("leaves a URL with nothing secret in it alone", () => {
    for (const url of ["postgres://app@h/x", "Server=h;Database=x", "jdbc:IRIS://h:1972/USER", "h:1521/FREEPDB1"]) {
      expect(maskConnectionSecrets(url)).toBe(url);
    }
  });
});
