// Explicit synthetic read-only probe; compile separately from the helper and pass private JSON on stdin.
using System.Reflection;
using System.Text.Json;
using Microsoft.Data.SqlClient;
var output=Console.Out;Console.SetError(TextWriter.Null);Console.SetOut(TextWriter.Null);
try {
 using var request=JsonDocument.Parse(await Console.In.ReadToEndAsync());var r=request.RootElement;
 var builder=new SqlConnectionStringBuilder {DataSource=$"tcp:{r.GetProperty("host").GetString()},{r.GetProperty("port").GetInt32()}",InitialCatalog=r.GetProperty("database").GetString(),UserID=r.GetProperty("user").GetString(),Password=r.GetProperty("password").GetString(),Encrypt=SqlConnectionEncryptOption.Optional,TrustServerCertificate=false,Pooling=false,ConnectTimeout=10};
 if(builder.InitialCatalog!="fixture_mssql_source"||builder.UserID!="fixture_mssql_reader"||builder.DataSource!="tcp:mssql-fixture,1433")throw new InvalidOperationException();
 using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(60));using var connection=new SqlConnection(builder.ConnectionString);await connection.OpenAsync(deadline.Token);
 using(var command=new SqlCommand("SELECT is_read_only FROM sys.databases WHERE database_id=DB_ID()",connection)){if(Convert.ToInt32(await command.ExecuteScalarAsync(deadline.Token))!=1)throw new InvalidOperationException();}
 var type=Assembly.LoadFrom("/opt/steelkeep-dacfx/Steelkeep.DacFx.dll").GetType("Database")??throw new InvalidOperationException();
 var instance=Activator.CreateInstance(type,BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic,null,new object[]{connection,deadline.Token},null)??throw new InvalidOperationException();
 var text=type.GetMethod("Text",BindingFlags.Instance|BindingFlags.NonPublic)??throw new InvalidOperationException();
 async Task<string> Query(int size)=>await ((Task<string>)(text.Invoke(instance,new object[]{"SELECT REPLICATE(CAST(N'x' AS nvarchar(max)),"+size+") AS value FOR JSON PATH"})??throw new InvalidOperationException()));
 using var result=JsonDocument.Parse(await Query(5000));if(result.RootElement[0].GetProperty("value").GetString()?.Length!=5000)throw new InvalidOperationException();
 var refused=false;try{await Query(2200000);}catch(InvalidOperationException){refused=true;}if(!refused)throw new InvalidOperationException();
 await output.WriteAsync(JsonSerializer.Serialize(new{proof="mssql-long-json",valueCharacters=5000,overLimitRefused=true,sourceReadOnly=true}));
}catch{await output.WriteAsync("{\"proof\":\"mssql-long-json\",\"status\":\"refused\"}");Environment.ExitCode=1;}
