// Compile separately with the pinned helper dependencies. No SQL connection or deployment is performed.
using System.Reflection;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.SqlServer.Dac.Model;

var output = Console.Out;
Console.SetOut(TextWriter.Null);
Console.SetError(TextWriter.Null);
try {
    var helper = System.Reflection.Assembly.LoadFrom("/opt/steelkeep-dacfx/Steelkeep.DacFx.dll");
    var plan = helper.GetType("ApplicationDataPlan") ?? throw new InvalidOperationException();
    var sql = plan.GetMethod("VerifySql", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null) ?? throw new InvalidOperationException();
    var owners = plan.GetMethod("VerifySchemaOwners", BindingFlags.Public | BindingFlags.Static) ?? throw new InvalidOperationException();
    var security = plan.GetMethod("IsSecurityElement", BindingFlags.Public | BindingFlags.Static) ?? throw new InvalidOperationException();
    var checks = 0;
    void Check(bool value) { if (!value) throw new InvalidOperationException(); checks++; }
    void Rejected(Action run) { try { run(); } catch (TargetInvocationException error) when (error.InnerException is InvalidOperationException) { checks++; return; } throw new InvalidOperationException(); }

    foreach (var text in new[] {
        "CREATE TABLE dbo.[User]([role] nvarchar(50),[login] int);",
        "IF OBJECT_ID(N'dbo.fixture',N'U') IS NULL BEGIN CREATE TABLE dbo.fixture(id int); END;",
        "CREATE SCHEMA app AUTHORIZATION dbo;"
    }) { sql.Invoke(null, new object[] { text }); checks++; }
    foreach (var text in new[] {
        "CREATE LOGIN source_login WITH PASSWORD='ModelOnly!A1password';",
        "CREATE USER source_user FOR LOGIN source_login;",
        "ALTER ROLE db_owner ADD MEMBER source_user;",
        "GRANT SELECT ON dbo.fixture TO source_user;",
        "DENY SELECT ON dbo.fixture TO source_user;",
        "REVOKE SELECT ON dbo.fixture FROM source_user;",
        "IF 1=1 BEGIN GRANT CONTROL ON DATABASE::fixture TO source_user; END;",
        "EXEC(N'CREATE USER source_user WITHOUT LOGIN');",
        "EXECUTE AS USER='source_user';",
        "ALTER AUTHORIZATION ON SCHEMA::dbo TO source_user;",
        "CREATE SCHEMA app AUTHORIZATION source_user;",
        "CREATE DATABASE another_database;",
        "ALTER DATABASE fixture SET TRUSTWORTHY ON;"
    }) Rejected(() => sql.Invoke(null, new object[] { text }));
    var sdkSql = plan.GetMethod("VerifySql", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string), typeof(string) }, null)!;
    var databaseHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("fixture")));
    sdkSql.Invoke(null, new object[] { ":setvar DatabaseName \"fixture\"\n:on error exit\nCREATE TABLE dbo.fixture(id int);", databaseHash }); checks++;
    foreach (var text in new[] {
        ":r /tmp/user-selected.sql",
        ":on error ignore",
        ":setvar DatabaseName \"another_database\"\nCREATE TABLE dbo.fixture(id int);",
        ":setvar UserSql \"anything\"",
        ":setvar DatabaseName \"fixture\"\nGRANT CONTROL ON DATABASE::fixture TO source_user;"
    }) Rejected(() => sdkSql.Invoke(null, new object[] { text, databaseHash }));

    using (var model = new TSqlModel(SqlServerVersion.Sql160, new TSqlModelOptions())) {
        model.AddObjects("CREATE SCHEMA app AUTHORIZATION dbo;");
        owners.Invoke(null, new object[] { model }); checks++;
    }
    using (var model = new TSqlModel(SqlServerVersion.Sql160, new TSqlModelOptions())) {
        model.AddObjects("CREATE USER source_owner WITHOUT LOGIN;\nGO\nCREATE SCHEMA app AUTHORIZATION source_owner;");
        Rejected(() => owners.Invoke(null, new object[] { model }));
    }
    using (var model = new TSqlModel(SqlServerVersion.Sql160, new TSqlModelOptions())) {
        model.AddObjects("CREATE LOGIN source_login WITH PASSWORD='ModelOnly!A1password';\nGO\nCREATE USER source_user FOR LOGIN source_login;\nGO\nCREATE ROLE source_role;\nGO\nALTER ROLE source_role ADD MEMBER source_user;\nGO\nCREATE TABLE dbo.fixture(id int);\nGO\nGRANT SELECT ON dbo.fixture TO source_user;");
        var elements = model.GetObjects(DacQueryScopes.UserDefined).ToArray();
        Check(elements.Count(element => (bool)security.Invoke(null, new object[] { element })!) >= 5);
        Check(elements.Any(element => element.ObjectType == ModelSchema.Table && !(bool)security.Invoke(null, new object[] { element })!));
    }

    var directory = "/tmp/steelkeep-policy-unit-" + Guid.NewGuid().ToString("N");
    Directory.CreateDirectory(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    Environment.SetEnvironmentVariable("DOTNET_CLI_HOME", directory);
    try {
        var type = helper.GetType("ImportPolicySession") ?? throw new InvalidOperationException();
        var create = type.GetMethod("Create", BindingFlags.Public | BindingFlags.Static)!;
        var open = type.GetMethod("Open", BindingFlags.Public | BindingFlags.Static)!;
        var verify = type.GetMethod("VerifyReceipt", BindingFlags.Public | BindingFlags.Instance)!;
        var ack = type.GetMethod("Acknowledge", BindingFlags.Public | BindingFlags.Instance)!;
        using var first = (IDisposable)create.Invoke(null, new object[] { "fixture" })!;
        using var second = (IDisposable)create.Invoke(null, new object[] { "fixture" })!;
        Rejected(() => verify.Invoke(first, null));
        var policyArgs = ((string)type.GetProperty("Arguments")!.GetValue(first)!).Split(';').Select(item => item.Split('=', 2)).ToDictionary(item => item[0], item => item[1]);
        using (var opened = (IDisposable)open.Invoke(null, new object[] { policyArgs })!) { checks++; }
        policyArgs["Steelkeep.PolicyNonce"] = new string('0', 64);
        Rejected(() => open.Invoke(null, new object[] { policyArgs }));
        ack.Invoke(first, new object[] { 5, 10 }); verify.Invoke(first, null); checks++;
        var firstDir = (string)type.GetProperty("DirectoryPath")!.GetValue(first)!;
        var secondDir = (string)type.GetProperty("DirectoryPath")!.GetValue(second)!;
        File.Copy(Path.Combine(firstDir, "applied.json"), Path.Combine(secondDir, "applied.json"));
        File.SetUnixFileMode(Path.Combine(secondDir, "applied.json"), UnixFileMode.UserRead | UnixFileMode.UserWrite);
        Rejected(() => verify.Invoke(second, null));
    } finally { Directory.Delete(directory, true); }
    await output.WriteAsync(JsonSerializer.Serialize(new { proof = "mssql-policy-unit", assertions = checks, status = "passed", sqlConnections = 0 }));
} catch {
    await output.WriteAsync("{\"proof\":\"mssql-policy-unit\",\"status\":\"refused\"}");
    Environment.ExitCode = 1;
}
