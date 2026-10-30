using System.Data;
using System.Diagnostics;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.Dac;

// Credentials arrive only on stdin. Never serialize exceptions, SQL, credentials or driver diagnostics.
Console.SetError(TextWriter.Null);
var protocolOutput = Console.Out;
Console.SetOut(TextWriter.Null);
try {
    if (!OperatingSystem.IsLinux() || System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture != System.Runtime.InteropServices.Architecture.X64) throw new InvalidOperationException();
    var input = new StringBuilder();
    var chars = new char[4096];
    int n;
    while ((n = await Console.In.ReadAsync(chars)) > 0) { input.Append(chars, 0, n); if (input.Length > 128 * 1024) throw new InvalidOperationException(); }
    var request = JsonSerializer.Deserialize<Request>(input.ToString(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? throw new InvalidOperationException();
    if (request.Port is < 1 or > 65535 || request.Database.Length == 0 || new[] { "master", "model", "msdb", "tempdb", "steelkeep" }.Contains(request.Database.ToLowerInvariant())) throw new InvalidOperationException();
    var builder = new SqlConnectionStringBuilder {
        DataSource = $"tcp:{request.Host},{request.Port}", InitialCatalog = request.Database,
        UserID = request.User, Password = request.Password, ConnectTimeout = 10,
        TrustServerCertificate = false, PersistSecurityInfo = false, Pooling = false,
        ApplicationName = "Steelkeep DacFx", MultipleActiveResultSets = false
    };
    builder["Encrypt"] = request.Tls ? "Mandatory" : "Optional";
    using var deadline = new CancellationTokenSource(TimeSpan.FromHours(2));
    using var connection = new SqlConnection(builder.ConnectionString);
    await connection.OpenAsync(deadline.Token);
    var db = new Database(connection, deadline.Token);
    var identity = await db.Identity(request.Database);
    var empty = await db.Empty();
    var restricted = request.RestoreTarget && await db.Restricted();
    object? manifest = null;
    if (request.Mode == "manifest") { if (!request.RestoreTarget) await db.ReadOnlySource(); manifest = await db.Manifest(identity); }
    else if (request.Mode is "export" or "import") {
        if (string.IsNullOrEmpty(request.File) || !Path.IsPathFullyQualified(request.File)) throw new InvalidOperationException();
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
            if (!restricted || !empty || !await db.Empty()) throw new InvalidOperationException();
            using var package = BacPackage.Load(request.File);
            service.ImportBacpac(package, request.Database, new DacImportOptions {
                CommandTimeout = 120, LongRunningCommandTimeout = 7200, DatabaseLockTimeout = 15,
                PreserveIdentityLastValues = true, HashObjectNamesInLogs = true
            }, deadline.Token);
        }
    } else if (request.Mode != "inspect") throw new InvalidOperationException();
    var actualVersion = FileVersionInfo.GetVersionInfo(typeof(DacServices).Assembly.Location).FileVersion;
    if (string.IsNullOrWhiteSpace(actualVersion) || !actualVersion.StartsWith("170.", StringComparison.Ordinal)) throw new InvalidOperationException();
    var result = JsonSerializer.Serialize(new { identity, empty, restricted, manifest, toolVersion = "DacFx " + actualVersion, packageVersion = "170.5.96" });
    if (Encoding.UTF8.GetByteCount(result) > 2 * 1024 * 1024) throw new InvalidOperationException();
    await protocolOutput.WriteAsync(result);
} catch { Environment.ExitCode = 1; }

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
    private SqlCommand Command(string sql) => new(sql, connection) { CommandTimeout = 120 };
    private async Task<int> Number(string sql) { using var command = Command(sql); return Convert.ToInt32(await command.ExecuteScalarAsync(cancellation)); }
    private async Task<string> Text(string sql) { using var command = Command(sql); return Convert.ToString(await command.ExecuteScalarAsync(cancellation)) ?? ""; }
    private static string Quote(string name) => "[" + name.Replace("]", "]]") + "]";
    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    public async Task<Identity> Identity(string expected) {
        if (await Text("SELECT DB_NAME()") != expected || await Number("SELECT CONVERT(int,SERVERPROPERTY('ProductMajorVersion'))") is not (15 or 16)) throw new InvalidOperationException();
        return new Identity("mssql", expected, await Text("SELECT CONVERT(nvarchar(128),SERVERPROPERTY('ProductVersion'))"), await Text("SELECT CONVERT(nvarchar(128),SERVERPROPERTY('ServerName'))") + ":" + expected);
    }
    public async Task ReadOnlySource() {
        if (await Number("SELECT is_read_only FROM sys.databases WHERE database_id=DB_ID()") != 1) throw new InvalidOperationException();
    }
    private const string ExtraObjects = "SELECT (SELECT COUNT(*) FROM sys.database_scoped_credentials)+(SELECT COUNT(*) FROM sys.external_data_sources)+(SELECT COUNT(*) FROM sys.external_file_formats)+(SELECT COUNT(*) FROM sys.assemblies WHERE is_user_defined=1)+(SELECT COUNT(*) FROM sys.security_policies)+(SELECT COUNT(*) FROM sys.partition_functions)+(SELECT COUNT(*) FROM sys.certificates)+(SELECT COUNT(*) FROM sys.symmetric_keys)+(SELECT COUNT(*) FROM sys.asymmetric_keys)+(SELECT COUNT(*) FROM sys.external_libraries)+(SELECT COUNT(*) FROM sys.external_languages)+(SELECT COUNT(*) FROM sys.xml_schema_collections WHERE xml_collection_id>0 AND schema_id<>4)";
    public async Task<bool> Empty() => await Number("SELECT COUNT(*) FROM sys.objects WHERE is_ms_shipped=0") == 0 && await Number("SELECT COUNT(*) FROM sys.schemas WHERE schema_id>4 AND schema_id<16384") == 0 && await Number("SELECT COUNT(*) FROM sys.types WHERE is_user_defined=1") == 0 && await Number(ExtraObjects) == 0;
    public async Task<bool> Restricted() {
        if (await Number("SELECT CASE WHEN IS_ROLEMEMBER('db_owner')=1 AND HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','VIEW DEFINITION')=1 THEN 1 ELSE 0 END") != 1) return false;
        return await Number("SELECT COUNT(*) FROM sys.fn_my_permissions(NULL,'SERVER') WHERE permission_name NOT IN ('CONNECT SQL','VIEW ANY DATABASE')") == 0;
    }
    public async Task<object> Manifest(Identity identity) {
        if (await Number("SELECT CASE WHEN HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','VIEW DEFINITION')=1 THEN 0 ELSE 1 END") != 0) throw new InvalidOperationException();
        // This application-data profile rejects features without an independent portable validator.
        if (await Number("SELECT COUNT(*) FROM sys.objects WHERE is_ms_shipped=0 AND type NOT IN ('U','PK','UQ','F','C','D','SO')") != 0 ||
            await Number("SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped=0 AND (is_memory_optimized=1 OR temporal_type<>0 OR is_filetable=1 OR is_tracked_by_cdc=1 OR is_replicated=1)") != 0 ||
            await Number("SELECT COUNT(*) FROM sys.columns WHERE is_filestream=1 OR is_sparse=1 OR is_column_set=1 OR encryption_type IS NOT NULL OR generated_always_type<>0 OR is_hidden=1 OR is_computed=1") != 0 ||
            await Number("SELECT COUNT(*) FROM sys.fulltext_indexes") != 0 || await Number("SELECT COUNT(*) FROM sys.external_tables") != 0 || await Number("SELECT COUNT(*) FROM sys.types WHERE is_user_defined=1") != 0 || await Number(ExtraObjects) != 0) throw new InvalidOperationException();
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
            var columns = new List<string>();
            using (var command = Command($"SELECT c.name,ty.name FROM sys.columns c JOIN sys.types ty ON ty.user_type_id=c.user_type_id WHERE c.object_id={table.Id} ORDER BY c.column_id"))
            using (var reader = await command.ExecuteReaderAsync(cancellation)) {
                while (await reader.ReadAsync(cancellation)) {
                    if (!new[] { "tinyint","smallint","int","bigint","bit","decimal","numeric","float","real","money","smallmoney","char","varchar","nchar","nvarchar","binary","varbinary","uniqueidentifier","date","datetime","datetime2","smalldatetime","datetimeoffset","time" }.Contains(reader.GetString(1))) throw new InvalidOperationException();
                    columns.Add(reader.GetString(0));
                }
            }
            var name = table.Schema + "." + table.Name;
            // Catalog JSON uses names/ordinals, never instance-specific object IDs.
            var schema = await Text($"SELECT c.name,ty.name AS type,c.max_length,c.precision,c.scale,c.is_nullable,c.collation_name,c.is_identity,dc.definition FROM sys.columns c JOIN sys.types ty ON ty.user_type_id=c.user_type_id LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id WHERE c.object_id={table.Id} ORDER BY c.column_id FOR JSON PATH,INCLUDE_NULL_VALUES");
            var indexes = await Text($"SELECT i.name,i.type_desc,i.is_unique,i.is_primary_key,i.is_unique_constraint,i.has_filter,i.filter_definition,(SELECT c.name,ic.key_ordinal,ic.is_descending_key,ic.is_included_column FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id ORDER BY ic.index_column_id FOR JSON PATH) AS cols FROM sys.indexes i WHERE i.object_id={table.Id} AND i.index_id>0 ORDER BY i.name FOR JSON PATH,INCLUDE_NULL_VALUES");
            var checks = await Text($"SELECT name,definition,is_disabled,is_not_trusted FROM sys.check_constraints WHERE parent_object_id={table.Id} ORDER BY name FOR JSON PATH,INCLUDE_NULL_VALUES");
            var foreign = await Text($"SELECT f.name,OBJECT_SCHEMA_NAME(f.referenced_object_id) AS target_schema,OBJECT_NAME(f.referenced_object_id) AS target_table,f.delete_referential_action,f.update_referential_action,f.is_disabled,f.is_not_trusted,(SELECT COL_NAME(fc.parent_object_id,fc.parent_column_id) AS col,COL_NAME(fc.referenced_object_id,fc.referenced_column_id) AS target_col FROM sys.foreign_key_columns fc WHERE fc.constraint_object_id=f.object_id ORDER BY fc.constraint_column_id FOR JSON PATH) AS cols FROM sys.foreign_keys f WHERE f.parent_object_id={table.Id} ORDER BY f.name FOR JSON PATH,INCLUDE_NULL_VALUES");
            objects[name] = Hash(schema + "\n" + indexes + "\n" + checks + "\n" + foreign);
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
            sequences[name] = await Text($"SELECT name,CONVERT(nvarchar(100),seed_value) AS seed,CONVERT(nvarchar(100),increment_value) AS increment,CONVERT(nvarchar(100),last_value) AS last FROM sys.identity_columns WHERE object_id={table.Id} ORDER BY name FOR JSON PATH,INCLUDE_NULL_VALUES");
        }
        sequences["$sequences"] = await Text("SELECT SCHEMA_NAME(schema_id) AS schema_name,name,CONVERT(nvarchar(100),start_value) AS start,CONVERT(nvarchar(100),increment) AS increment,CONVERT(nvarchar(100),minimum_value) AS min,CONVERT(nvarchar(100),maximum_value) AS max,is_cycling,CONVERT(nvarchar(100),current_value) AS current_value FROM sys.sequences ORDER BY SCHEMA_NAME(schema_id),name FOR JSON PATH,INCLUDE_NULL_VALUES");
        objects["$database"] = Hash(await Text("SELECT collation_name,compatibility_level FROM sys.databases WHERE database_id=DB_ID() FOR JSON PATH"));
        return new { format = 1, identity.engine, identity.database, identity.serverVersion, objects, data, sequences };
    }
}
