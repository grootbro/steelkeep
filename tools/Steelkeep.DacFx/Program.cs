using System.Data;
using System.Diagnostics;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.Dac;
using Microsoft.SqlServer.Dac.Deployment;
using Microsoft.SqlServer.Dac.Model;
using Microsoft.SqlServer.TransactSql.ScriptDom;

// Credentials arrive only on stdin. Never serialize exceptions, SQL, credentials or driver diagnostics.
Console.SetError(TextWriter.Null);
var protocolOutput = Console.Out;
Console.SetOut(TextWriter.Null);
var stage = "request";
Database? db = null;
object? policyDiagnostic = null;
try {
    if (!OperatingSystem.IsLinux() || System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture != System.Runtime.InteropServices.Architecture.X64) throw new InvalidOperationException();
    var input = new StringBuilder();
    var chars = new char[4096];
    int n;
    while ((n = await Console.In.ReadAsync(chars)) > 0) { input.Append(chars, 0, n); if (input.Length > 128 * 1024) throw new InvalidOperationException(); }
    var request = JsonSerializer.Deserialize<Request>(input.ToString(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? throw new InvalidOperationException();
    if (request.Port is < 1 or > 65535 || request.Database.Length == 0 || new[] { "master", "model", "msdb", "tempdb", "steelkeep" }.Contains(request.Database.ToLowerInvariant())) throw new InvalidOperationException();
    stage = "connection";
    var builder = new SqlConnectionStringBuilder {
        DataSource = $"tcp:{request.Host},{request.Port}", InitialCatalog = request.Database,
        UserID = request.User, Password = request.Password, ConnectTimeout = 10,
        TrustServerCertificate = false, PersistSecurityInfo = false, Pooling = false,
        ApplicationName = "Steelkeep DacFx", MultipleActiveResultSets = false
    };
    builder["Encrypt"] = request.Tls ? "Mandatory" : "Optional";
    using var deadline = new CancellationTokenSource(request.Mode == "plan" ? TimeSpan.FromMinutes(2) : TimeSpan.FromHours(2));
    using var connection = new SqlConnection(builder.ConnectionString);
    await connection.OpenAsync(deadline.Token);
    db = new Database(connection, deadline.Token);
    stage = "identity";
    var identity = await db.Identity(request.Database);
    stage = "catalog";
    var empty = await db.Empty();
    var restricted = request.RestoreTarget && await db.Restricted();
    object? manifest = null;
    string? importPolicy = null;
    object? importPolicyReceipt = null;
    if (request.Mode == "manifest") { stage = "manifest"; if (!request.RestoreTarget) await db.ReadOnlySource(); manifest = await db.Manifest(identity); }
    else if (request.Mode is "export" or "import" or "plan") {
        if (string.IsNullOrEmpty(request.File) || !Path.IsPathFullyQualified(request.File)) throw new InvalidOperationException();
        stage = request.Mode;
        var service = new DacServices(builder.ConnectionString);
        if (request.Mode == "export") {
            if (request.RestoreTarget || File.Exists(request.File)) throw new InvalidOperationException();
            await db.ReadOnlySource();
            // All table data; no contributor, SQL script or caller-selected extraction scope.
            service.ExportBacpac(request.File, request.Database, new DacExportOptions {
                CommandTimeout = 120, LongRunningCommandTimeout = 7200, DatabaseLockTimeout = 15,
                VerifyExtraction = true, HashObjectNamesInLogs = true,
                TempDirectoryForTableData = Path.GetDirectoryName(request.File)
            }, null, deadline.Token);
            await db.ReadOnlySource();
        } else {
            stage = "import_policy";
            if (!restricted || !empty || !await db.Empty()) throw new InvalidOperationException();
            stage = "import_model";
            using var model = TSqlModel.LoadFromDacpac(request.File, new ModelLoadOptions { LoadAsScriptBackedModel = true }, deadline.Token);
            ApplicationDataPlan.VerifySchemaOwners(model);
            stage = "import_policy";
            using var policy = ImportPolicySession.Create(request.Database);
            try {
            if (request.Mode == "plan") {
                // Schema-only SDK diagnostics: no Import/Deploy call, package rewriting or target writes.
                var schemaFile = Path.Combine(policy.DirectoryPath, "schema.dacpac");
                DacPackageExtensions.BuildPackage(schemaFile, model, new PackageMetadata { Name = "Steelkeep policy verification", Version = "1.0.0.0" });
                using var schema = DacPackage.Load(schemaFile);
                stage = "import_plan";
                service.GenerateDeployScript(schema, request.Database, new DacDeployOptions {
                    AdditionalDeploymentContributors = ImportPolicySession.ContributorId,
                    AdditionalDeploymentContributorPaths = AppContext.BaseDirectory,
                    AdditionalDeploymentContributorArguments = policy.Arguments,
                    DropObjectsNotInSource = false, CreateNewDatabase = false,
                    CommandTimeout = 120, LongRunningCommandTimeout = 120
                }, deadline.Token);
            } else {
                stage = "import";
                using var package = BacPackage.Load(request.File);
                // The required modifier is the execution gate; no optional contributor or fallback import.
                service.ImportBacpac(package, request.Database, new DacImportOptions {
                    CommandTimeout = 120, LongRunningCommandTimeout = 7200, DatabaseLockTimeout = 15,
                    PreserveIdentityLastValues = true, HashObjectNamesInLogs = true,
                    ImportContributors = ImportPolicySession.ContributorId,
                    ImportContributorPaths = AppContext.BaseDirectory,
                    ImportContributorArguments = policy.Arguments
                }, deadline.Token);
            }
            } catch { policyDiagnostic = policy.Diagnostics(); throw; }
            stage = "import_guard";
            var receipt = policy.VerifyReceipt();
            importPolicy = ImportPolicySession.PolicyVersion;
            importPolicyReceipt = new { receipt.RemovedSecurityElements, receipt.VerifiedPlanSteps, nonceBound = true, contributorVersion = ImportPolicySession.ContributorVersion };
        }
    } else if (request.Mode != "inspect") throw new InvalidOperationException();
    stage = "runtime";
    var actualVersion = FileVersionInfo.GetVersionInfo(typeof(DacServices).Assembly.Location).FileVersion;
    if (string.IsNullOrWhiteSpace(actualVersion) || !actualVersion.StartsWith("170.", StringComparison.Ordinal)) throw new InvalidOperationException();
    var result = JsonSerializer.Serialize(new { identity, empty, restricted, manifest, importPolicy, importPolicyReceipt, toolVersion = "DacFx " + actualVersion, packageVersion = "170.5.96" });
    if (Encoding.UTF8.GetByteCount(result) > 2 * 1024 * 1024) throw new InvalidOperationException();
    await protocolOutput.WriteAsync(result);
} catch (Exception error) {
    var dacCodes = error is DacServicesException dac ? dac.Messages.Select(message => message.Number).Where(number => number is 71501 or 71561 or 71627 or 71659 or 72000 or 72001 or 72002 or 72003 or 72004 or 72005 or 72014 or 72030 or 72045 or 72060).Distinct().Take(8).ToArray() : Array.Empty<int>();
    var sqlCode = error.GetBaseException() is SqlException native && new[] { 229, 230, 262, 297, 300, 916, 15247, 15151, 3906, 2714, 18456 }.Contains(native.Number) ? native.Number : (int?)null;
    var kind = error switch { DacServicesException => "sdk", DacModelException => "model", SqlException => "sql", InvalidOperationException => "validation", IOException => "file", UnauthorizedAccessException => "filesystem", JsonException => "protocol", _ => "runtime" };
    // A handled protocol failure stays machine-readable; no exception or driver text leaves the helper.
    await protocolOutput.WriteAsync(JsonSerializer.Serialize(new { error = new { code = "MSSQL_HELPER_FAILED", stage = stage == "manifest" ? db?.ManifestStage ?? stage : stage, dacCodes, sqlCode, kind, policyDiagnostic } }));
}

sealed record Request {
    public string Mode { get; init; } = "";
    public string Host { get; init; } = "";
    public int Port { get; init; }
    public string Database { get; init; } = "";
    public string User { get; init; } = "";
    public string Password { get; init; } = "";
    public bool Tls { get; init; } = true;
    public bool RestoreTarget { get; init; }
    public string? File { get; init; }
}
sealed record Identity(string engine, string database, string serverVersion, string binding);

sealed class Database(SqlConnection connection, CancellationToken cancellation) {
    public string ManifestStage { get; private set; } = "manifest";
    private SqlCommand Command(string sql) => new(sql, connection) { CommandTimeout = 120 };
    private async Task<int> Number(string sql) { using var command = Command(sql); return Convert.ToInt32(await command.ExecuteScalarAsync(cancellation)); }
    private async Task<string> Text(string sql) {
        using var command = Command(sql);
        using var reader = await command.ExecuteReaderAsync(cancellation);
        if (reader.FieldCount != 1) throw new InvalidOperationException();
        var text = new StringBuilder();
        // FOR JSON returns large catalog documents in multiple rows.
        while (await reader.ReadAsync(cancellation)) {
            var part = await reader.IsDBNullAsync(0, cancellation) ? "" : reader.GetString(0);
            if (text.Length + part.Length > 2 * 1024 * 1024) throw new InvalidOperationException();
            text.Append(part);
        }
        return text.ToString();
    }
    private static string Quote(string name) => "[" + name.Replace("]", "]]") + "]";
    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    public async Task<Identity> Identity(string expected) {
        if (await Text("SELECT DB_NAME()") != expected || await Number("SELECT CONVERT(int,SERVERPROPERTY('ProductMajorVersion'))") is not (15 or 16)) throw new InvalidOperationException();
        return new Identity("mssql", expected, await Text("SELECT CONVERT(nvarchar(128),SERVERPROPERTY('ProductVersion'))"), await Text("SELECT CONVERT(nvarchar(128),SERVERPROPERTY('ServerName'))") + ":" + expected);
    }
    public async Task ReadOnlySource() {
        if (await Number("SELECT is_read_only FROM sys.databases WHERE database_id=DB_ID()") != 1) throw new InvalidOperationException();
    }
    // R/Python are reserved built-in languages, including in otherwise empty SQL Server 2022 databases.
    private const string ExtraObjects = "SELECT (SELECT COUNT(*) FROM sys.database_scoped_credentials)+(SELECT COUNT(*) FROM sys.external_data_sources)+(SELECT COUNT(*) FROM sys.external_file_formats)+(SELECT COUNT(*) FROM sys.assemblies WHERE is_user_defined=1)+(SELECT COUNT(*) FROM sys.security_policies)+(SELECT COUNT(*) FROM sys.partition_functions)+(SELECT COUNT(*) FROM sys.certificates)+(SELECT COUNT(*) FROM sys.symmetric_keys)+(SELECT COUNT(*) FROM sys.asymmetric_keys)+(SELECT COUNT(*) FROM sys.external_libraries)+(SELECT COUNT(*) FROM sys.external_languages WHERE language NOT IN (N'R',N'Python'))+(SELECT COUNT(*) FROM sys.xml_schema_collections WHERE xml_collection_id>0 AND schema_id<>4)";
    public async Task<bool> Empty() => await Number("SELECT COUNT(*) FROM sys.objects WHERE is_ms_shipped=0") == 0 && await Number("SELECT COUNT(*) FROM sys.schemas WHERE schema_id>4 AND schema_id<16384") == 0 && await Number("SELECT COUNT(*) FROM sys.types WHERE is_user_defined=1") == 0 && await Number(ExtraObjects) == 0;
    public async Task<bool> Restricted() {
        if (await Number("SELECT CASE WHEN IS_ROLEMEMBER('db_owner')=1 AND HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','VIEW DEFINITION')=1 THEN 1 ELSE 0 END") != 1) return false;
        return await Number("SELECT COUNT(*) FROM sys.fn_my_permissions(NULL,'SERVER') WHERE permission_name NOT IN ('CONNECT SQL','VIEW ANY DATABASE')") == 0;
    }
    public async Task<object> Manifest(Identity identity) {
        ManifestStage = "manifest_permissions";
        if (await Number("SELECT CASE WHEN HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','VIEW DEFINITION')=1 THEN 0 ELSE 1 END") != 0) throw new InvalidOperationException();
        ManifestStage = "manifest_features";
        // This application-data profile rejects features without an independent portable validator.
        if (await Number("SELECT COUNT(*) FROM sys.objects WHERE is_ms_shipped=0 AND type NOT IN ('U','PK','UQ','F','C','D','SO')") != 0 ||
            await Number("SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped=0 AND (is_memory_optimized=1 OR temporal_type<>0 OR is_filetable=1 OR is_tracked_by_cdc=1 OR is_replicated=1)") != 0 ||
            await Number("SELECT COUNT(*) FROM sys.schemas WHERE schema_id>4 AND schema_id<16384 AND principal_id<>DATABASE_PRINCIPAL_ID('dbo')") != 0 ||
            await Number("SELECT COUNT(*) FROM sys.columns c JOIN sys.tables t ON t.object_id=c.object_id WHERE t.is_ms_shipped=0 AND (c.is_filestream=1 OR c.is_sparse=1 OR c.is_column_set=1 OR c.encryption_type IS NOT NULL OR c.generated_always_type<>0 OR c.is_hidden=1 OR c.is_computed=1)") != 0 ||
            await Number("SELECT COUNT(*) FROM sys.fulltext_indexes") != 0 || await Number("SELECT COUNT(*) FROM sys.external_tables") != 0 || await Number("SELECT COUNT(*) FROM sys.types WHERE is_user_defined=1") != 0 || await Number(ExtraObjects) != 0) throw new InvalidOperationException();
        ManifestStage = "manifest_tables";
        var tables = new List<(int Id, string Schema, string Name)>();
        using (var command = Command("SELECT t.object_id,s.name,t.name FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE t.is_ms_shipped=0 ORDER BY s.name,t.name"))
        using (var reader = await command.ExecuteReaderAsync(cancellation)) {
            while (await reader.ReadAsync(cancellation)) { if (tables.Count >= 500) throw new InvalidOperationException(); tables.Add((reader.GetInt32(0),reader.GetString(1),reader.GetString(2))); }
        }
        var objects = new SortedDictionary<string,object>(StringComparer.Ordinal);
        var data = new SortedDictionary<string,object>(StringComparer.Ordinal);
        var sequences = new SortedDictionary<string,object>(StringComparer.Ordinal);
        long totalBytes = 0, totalRows = 0;
        foreach (var table in tables) {
            ManifestStage = "manifest_columns";
            var columns = new List<string>();
            using (var command = Command($"SELECT c.name,ty.name FROM sys.columns c JOIN sys.types ty ON ty.user_type_id=c.user_type_id WHERE c.object_id={table.Id} ORDER BY c.column_id"))
            using (var reader = await command.ExecuteReaderAsync(cancellation)) {
                while (await reader.ReadAsync(cancellation)) {
                    if (!new[] { "tinyint","smallint","int","bigint","bit","decimal","numeric","float","real","money","smallmoney","char","varchar","nchar","nvarchar","binary","varbinary","uniqueidentifier","date","datetime","datetime2","smalldatetime","datetimeoffset","time" }.Contains(reader.GetString(1))) throw new InvalidOperationException();
                    columns.Add(reader.GetString(0));
                }
            }
            var name = table.Schema + "." + table.Name;
            ManifestStage = "manifest_schema";
            // Catalog JSON uses names/ordinals, never instance-specific object IDs.
            var schema = await Text($"SELECT c.name,ty.name AS type,c.max_length,c.precision,c.scale,c.is_nullable,c.collation_name,c.is_identity,dc.definition FROM sys.columns c JOIN sys.types ty ON ty.user_type_id=c.user_type_id LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id WHERE c.object_id={table.Id} ORDER BY c.column_id FOR JSON PATH,INCLUDE_NULL_VALUES");
            var indexes = await Text($"SELECT i.name,i.type_desc,i.is_unique,i.is_primary_key,i.is_unique_constraint,i.has_filter,i.filter_definition,(SELECT c.name,ic.key_ordinal,ic.is_descending_key,ic.is_included_column FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id ORDER BY ic.index_column_id FOR JSON PATH) AS cols FROM sys.indexes i WHERE i.object_id={table.Id} AND i.index_id>0 ORDER BY i.name FOR JSON PATH,INCLUDE_NULL_VALUES");
            var checks = await Text($"SELECT name,definition,is_disabled,is_not_trusted FROM sys.check_constraints WHERE parent_object_id={table.Id} ORDER BY name FOR JSON PATH,INCLUDE_NULL_VALUES");
            var foreign = await Text($"SELECT f.name,OBJECT_SCHEMA_NAME(f.referenced_object_id) AS target_schema,OBJECT_NAME(f.referenced_object_id) AS target_table,f.delete_referential_action,f.update_referential_action,f.is_disabled,f.is_not_trusted,(SELECT COL_NAME(fc.parent_object_id,fc.parent_column_id) AS col,COL_NAME(fc.referenced_object_id,fc.referenced_column_id) AS target_col FROM sys.foreign_key_columns fc WHERE fc.constraint_object_id=f.object_id ORDER BY fc.constraint_column_id FOR JSON PATH) AS cols FROM sys.foreign_keys f WHERE f.parent_object_id={table.Id} ORDER BY f.name FOR JSON PATH,INCLUDE_NULL_VALUES");
            objects[name] = Hash(schema + "\n" + indexes + "\n" + checks + "\n" + foreign);
            ManifestStage = "manifest_data";
            long count = 0; BigInteger sum = BigInteger.Zero, xor = BigInteger.Zero;
            using (var command = Command("SELECT " + string.Join(",", columns.Select(column => "CONVERT(varbinary(max)," + Quote(column) + ")")) + " FROM " + Quote(table.Schema) + "." + Quote(table.Name)))
            using (var reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancellation)) {
                while (await reader.ReadAsync(cancellation)) {
                    if (++totalRows > 5_000_000) throw new InvalidOperationException();
                    using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                    for (int col = 0; col < columns.Count; col++) {
                        if (await reader.IsDBNullAsync(col,cancellation)) { digest.AppendData(new byte[] { 0 }); continue; }
                        digest.AppendData(new byte[] { 1 });
                        long length = reader.GetBytes(col,0,null,0,0);
                        if (length > 16 * 1024 * 1024 || (totalBytes += length) > 2L * 1024 * 1024 * 1024) throw new InvalidOperationException();
                        digest.AppendData(BitConverter.GetBytes(length));
                        long offset = 0; var buffer = new byte[65536];
                        while (offset < length) { int read = (int)reader.GetBytes(col,offset,buffer,0,(int)Math.Min(buffer.Length,length-offset)); if (read == 0) throw new InvalidOperationException(); digest.AppendData(buffer.AsSpan(0,read)); offset += read; }
                    }
                    var value = new BigInteger(digest.GetHashAndReset(), isUnsigned:true, isBigEndian:true);
                    sum = (sum + value) % (BigInteger.One << 256); xor ^= value; count++;
                }
            }
            data[name] = new { count = count.ToString(), sum = sum.ToString("x"), xor = xor.ToString("x") };
            ManifestStage = "manifest_sequences";
            sequences[name] = await Text($"SELECT name,CONVERT(nvarchar(100),seed_value) AS seed,CONVERT(nvarchar(100),increment_value) AS increment,CONVERT(nvarchar(100),last_value) AS last FROM sys.identity_columns WHERE object_id={table.Id} ORDER BY name FOR JSON PATH,INCLUDE_NULL_VALUES");
        }
        ManifestStage = "manifest_sequences";
        sequences["$sequences"] = await Text("SELECT SCHEMA_NAME(schema_id) AS schema_name,name,CONVERT(nvarchar(100),start_value) AS start,CONVERT(nvarchar(100),increment) AS increment,CONVERT(nvarchar(100),minimum_value) AS min,CONVERT(nvarchar(100),maximum_value) AS max,is_cycling,CONVERT(nvarchar(100),current_value) AS current_value FROM sys.sequences ORDER BY SCHEMA_NAME(schema_id),name FOR JSON PATH,INCLUDE_NULL_VALUES");
        ManifestStage = "manifest_schema";
        objects["$database"] = Hash(await Text("SELECT collation_name,compatibility_level FROM sys.databases WHERE database_id=DB_ID() FOR JSON PATH"));
        return new { format = 1, identity.engine, identity.database, identity.serverVersion, objects, data, sequences };
    }
}

// Required, compiled-in modifier. Callers cannot select contributors or supply SQL.
[ExportDeploymentPlanModifier(ImportPolicySession.ContributorId, ImportPolicySession.ContributorVersion)]
public sealed class SteelkeepApplicationDataContributor : DeploymentPlanModifier {
    protected override void OnExecute(DeploymentPlanContributorContext context) {
        using var session = ImportPolicySession.Open(context.Arguments);
        session.Enter();
        int removed = 0, verified = 0;
        string stepKind = "none";
        try {
        ApplicationDataPlan.VerifySchemaOwners(context.Source);
        for (var step = context.PlanHandle.Head; step != null;) {
            if (++verified > 50_000) throw new InvalidOperationException();
            var next = step.Next;
            var element = step switch {
                CreateElementStep create => create.SourceElement,
                AlterElementStep alter => alter.SourceElement,
                DropElementStep drop => drop.TargetElement,
                _ => null
            };
            if (element != null && ApplicationDataPlan.IsSecurityElement(element)) {
                Remove(context.PlanHandle, step);
                removed++;
            }
            step = next;
        }
        foreach (var step in Remaining(context.PlanHandle)) {
            stepKind = step.GetType().Name;
            // Validate rendered SQL too: an SDK DOM snippet must not hide an uninspected security statement.
            foreach (var batch in step.GenerateTSQL()) ApplicationDataPlan.VerifySql(batch, session.DatabaseHash);
        }
        // DacFx cannot continue past this required callback unless the complete plan is safe and acknowledged.
        session.Acknowledge(removed, verified);
        } catch (Exception failure) {
            session.RecordDenial(failure is PolicyRefusal refusal ? refusal.Reason : "modifier_validation", stepKind, failure is PolicyRefusal denied ? denied.NodeKind : "none");
            throw;
        }
    }

    private static IEnumerable<DeploymentStep> Remaining(DeploymentPlanHandle plan) {
        int count = 0;
        for (var step = plan.Head; step != null; step = step.Next) {
            if (++count > 50_000) throw new InvalidOperationException();
            yield return step;
        }
    }
}

static class ApplicationDataPlan {
    private static readonly HashSet<ModelTypeClass> SecurityTypes = new() {
        ModelSchema.Login, ModelSchema.User, ModelSchema.Role, ModelSchema.ApplicationRole,
        ModelSchema.RoleMembership, ModelSchema.ServerRoleMembership,
        ModelSchema.UserDefinedServerRole, ModelSchema.Permission
    };

    public static bool IsSecurityElement(TSqlObject element) => SecurityTypes.Contains(element.ObjectType);

    public static void VerifySchemaOwners(TSqlModel model) {
        foreach (var schema in model.GetObjects(DacQueryScopes.UserDefined, ModelSchema.Schema)) {
            // Built-in dbo may be an unresolved model reference; its declared identity still must be explicit.
            var owners = schema.GetReferencedRelationshipInstances(Microsoft.SqlServer.Dac.Model.Schema.Authorizer).ToArray();
            if (owners.Length != 1 || !owners[0].ObjectName.Parts.SequenceEqual(new[] { "dbo" }, StringComparer.OrdinalIgnoreCase)) throw new PolicyRefusal("schema_owner");
        }
    }

    public static void VerifySql(string sql) => VerifySql(sql, null);

    public static void VerifySql(string sql, string? databaseHash) {
        if (string.IsNullOrWhiteSpace(sql)) return;
        if (sql.Length > 2 * 1024 * 1024) throw new PolicyRefusal("script_limit");
        using var text = new StringReader(WithoutSdkDirectives(sql, databaseHash));
        var fragment = new TSql160Parser(true).Parse(text, out var errors);
        if (errors.Count != 0) throw new PolicyRefusal("script_parse", "Parse" + errors[0].Number);
        VerifySql(fragment);
    }

    private static string WithoutSdkDirectives(string sql, string? databaseHash) {
        var lines = sql.Split('\n');
        for (int index = 0; index < lines.Length; index++) {
            var line = lines[index].Trim();
            if (!line.StartsWith(':')) continue;
            if (string.Equals(line, ":on error exit", StringComparison.OrdinalIgnoreCase) || string.Equals(line, ":onerror exit", StringComparison.OrdinalIgnoreCase)) { lines[index] = ""; continue; }
            var match = Regex.Match(line, "^:setvar[ \\t]+([A-Za-z_][A-Za-z0-9_]*)[ \\t]+\"([^\"\\r\\n]*)\"[ \\t]*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            if (!match.Success) throw new PolicyRefusal("sqlcmd_directive");
            var name = match.Groups[1].Value;
            var value = match.Groups[2].Value;
            if (value.Contains("$(", StringComparison.Ordinal)) throw new PolicyRefusal("sqlcmd_directive");
            if (name is "DatabaseName" or "DefaultFilePrefix") {
                if (databaseHash == null || Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))) != databaseHash) throw new PolicyRefusal("sqlcmd_directive");
            } else if (name is "DefaultDataPath" or "DefaultLogPath") {
                if (!Path.IsPathFullyQualified(value)) throw new PolicyRefusal("sqlcmd_directive");
            } else if (name != "__IsSqlCmdEnabled" || value != "True") throw new PolicyRefusal("sqlcmd_directive");
            // These are declarations/error-stop controls, not SQL. Includes, shell commands and unknown variables refuse.
            lines[index] = "";
        }
        return string.Join('\n', lines);
    }

    public static void VerifySql(TSqlFragment fragment) => fragment.Accept(new ApplicationSqlVisitor());

    private sealed class ApplicationSqlVisitor : TSqlFragmentVisitor {
        private static readonly string[] SecurityParts = { "Login", "User", "Role", "Permission", "Grant", "Deny", "Revoke", "Authorization", "ExecuteAs", "Credential", "Certificate", "MasterKey", "SymmetricKey", "AsymmetricKey", "EncryptionKey", "Signature", "Audit", "Containment", "Cryptographic", "External" };
        private static readonly string[] ModuleParts = { "Procedure", "Function", "View", "Trigger", "Server", "Endpoint" };
        private int visited;
        public override void Visit(TSqlFragment node) {
            if (++visited > 500_000) throw new PolicyRefusal("plan_limit");
            var kind = node.GetType().Name;
            if (SecurityParts.Any(part => kind.Contains(part, StringComparison.Ordinal)) ||
                kind is "ExecuteStatement" or "RevertStatement" or "CreateDatabaseStatement" or "DropDatabaseStatement" or "AlterDatabaseModifyNameStatement" or "AlterDatabaseAddFileStatement" or "AlterDatabaseModifyFileStatement" or "AlterDatabaseRemoveFileStatement" or "CreateAssemblyStatement" or "AlterAssemblyStatement" or "DropAssemblyStatement" ||
                kind.EndsWith("Snippet", StringComparison.Ordinal) ||
                kind.EndsWith("Statement", StringComparison.Ordinal) && ModuleParts.Any(part => kind.Contains(part, StringComparison.Ordinal))) throw new PolicyRefusal("residual_sql", kind);
            if (node is CreateSchemaStatement schema && schema.Owner != null && !string.Equals(schema.Owner.Value, "dbo", StringComparison.OrdinalIgnoreCase)) throw new PolicyRefusal("schema_owner", kind);
            if (node is OnOffDatabaseOption option && option.OptionKind.ToString() is "Trustworthy" or "DBChaining") throw new PolicyRefusal("database_security", kind);
        }
    }
}

sealed class PolicyRefusal(string reason, string nodeKind = "none") : InvalidOperationException {
    public string Reason { get; } = reason;
    public string NodeKind { get; } = nodeKind;
}

sealed class ImportPolicySession : IDisposable {
    public const string ContributorId = "Steelkeep.ApplicationDataOnly";
    public const string ContributorVersion = "1.0.0.0";
    public const string PolicyVersion = "application-schema-data-v1";
    private const string DirectoryArgument = "Steelkeep.PolicyDirectoryHex";
    private const string NonceArgument = "Steelkeep.PolicyNonce";
    private readonly bool owner;
    private readonly PolicyChallenge challenge;
    public string DirectoryPath { get; }
    public string DatabaseHash => challenge.DatabaseHash;
    public string Arguments => DirectoryArgument + "=" + Convert.ToHexString(Encoding.UTF8.GetBytes(DirectoryPath)) + ";" + NonceArgument + "=" + challenge.Nonce;

    private ImportPolicySession(string directory, PolicyChallenge value, bool ownsDirectory) { DirectoryPath = directory; challenge = value; owner = ownsDirectory; }

    public static ImportPolicySession Create(string database) {
        var parent = PrivateParent();
        var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var directory = Path.Combine(parent, "policy-" + nonce);
        if (Path.Exists(directory)) throw new InvalidOperationException();
        Directory.CreateDirectory(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var value = new PolicyChallenge(nonce, PolicyVersion, ContributorVersion, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(database))));
        WriteNew(Path.Combine(directory, "challenge.json"), value);
        return new ImportPolicySession(directory, value, true);
    }

    public static ImportPolicySession Open(IEnumerable<KeyValuePair<string, string>> arguments) {
        var values = arguments.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        if (values.Count != 2 || !values.TryGetValue(DirectoryArgument, out var encoded) || !values.TryGetValue(NonceArgument, out var nonce) || nonce.Length != 64 || nonce.Any(c => !char.IsAsciiHexDigit(c))) throw new InvalidOperationException();
        var directory = Encoding.UTF8.GetString(Convert.FromHexString(encoded));
        var expected = Path.Combine(PrivateParent(), "policy-" + nonce);
        if (!string.Equals(directory, expected, StringComparison.Ordinal) || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0 || File.GetUnixFileMode(directory) != (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)) throw new InvalidOperationException();
        var value = Read<PolicyChallenge>(Path.Combine(directory, "challenge.json"));
        if (value.Nonce != nonce || value.Policy != PolicyVersion || value.Contributor != ContributorVersion || value.DatabaseHash.Length != 64) throw new InvalidOperationException();
        return new ImportPolicySession(directory, value, false);
    }

    public void Acknowledge(int removed, int verified) => WriteNew(Path.Combine(DirectoryPath, "applied.json"), new PolicyReceipt(challenge, removed, verified));

    public void Enter() => WriteNew(Path.Combine(DirectoryPath, "entered.json"), challenge);
    public void RecordDenial(string reason, string step, string node) => WriteNew(Path.Combine(DirectoryPath, "denied.json"), new PolicyDenial(challenge, reason, SafeKind(step), SafeKind(node)));
    public object Diagnostics() {
        var file = Path.Combine(DirectoryPath, "denied.json");
        var denial = File.Exists(file) ? Read<PolicyDenial>(file) : null;
        if (denial != null && (denial.Challenge != challenge || !new[] { "schema_owner", "script_limit", "script_parse", "sqlcmd_directive", "plan_limit", "residual_sql", "database_security", "modifier_validation" }.Contains(denial.Reason))) throw new InvalidOperationException();
        return new { contributorEntered = File.Exists(Path.Combine(DirectoryPath, "entered.json")), planAcknowledged = File.Exists(Path.Combine(DirectoryPath, "applied.json")), reason = denial?.Reason, stepKind = denial?.StepKind, nodeKind = denial?.NodeKind };
    }
    private static string SafeKind(string value) => value.Length <= 100 && value.All(c => char.IsAsciiLetterOrDigit(c) || c == '_') ? value : "unknown";

    public (int RemovedSecurityElements, int VerifiedPlanSteps) VerifyReceipt() {
        var receipt = Read<PolicyReceipt>(Path.Combine(DirectoryPath, "applied.json"));
        if (receipt.Challenge != challenge || receipt.RemovedSecurityElements < 0 || receipt.VerifiedPlanSteps < receipt.RemovedSecurityElements || receipt.VerifiedPlanSteps > 50_000) throw new InvalidOperationException();
        return (receipt.RemovedSecurityElements, receipt.VerifiedPlanSteps);
    }

    private static string PrivateParent() {
        var directory = Environment.GetEnvironmentVariable("DOTNET_CLI_HOME");
        if (string.IsNullOrEmpty(directory) || !Path.IsPathFullyQualified(directory) || !Directory.Exists(directory) || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0 || File.GetUnixFileMode(directory) != (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)) throw new InvalidOperationException();
        return Path.GetFullPath(directory);
    }

    private static T Read<T>(string file) where T : class {
        var info = new FileInfo(file);
        if (!info.Exists || info.Length > 4096 || (info.Attributes & FileAttributes.ReparsePoint) != 0 || File.GetUnixFileMode(file) != (UnixFileMode.UserRead | UnixFileMode.UserWrite)) throw new InvalidOperationException();
        return JsonSerializer.Deserialize<T>(File.ReadAllText(file)) ?? throw new InvalidOperationException();
    }

    private static void WriteNew<T>(string file, T value) {
        using var stream = new FileStream(file, new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None, UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite });
        JsonSerializer.Serialize(stream, value);
    }

    public void Dispose() { if (owner) try { Directory.Delete(DirectoryPath, true); } catch { /* The caller also removes its private request directory. */ } }
    private sealed record PolicyChallenge(string Nonce, string Policy, string Contributor, string DatabaseHash);
    private sealed record PolicyReceipt(PolicyChallenge Challenge, int RemovedSecurityElements, int VerifiedPlanSteps);
    private sealed record PolicyDenial(PolicyChallenge Challenge, string Reason, string StepKind, string NodeKind);
}
