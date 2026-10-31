"""Create a separate deny-only compiler input for an explicitly authorized synthetic Import proof."""
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text()
entry = "        try {\n        ApplicationDataPlan.VerifySchemaOwners(context.Source);"
denial = '"database_security", "modifier_validation" }.Contains(denial.Reason)'
if source.count(entry) != 1 or source.count(denial) != 1:
    raise SystemExit("Refuse an unexpected helper source version")
source = source.replace(entry, """        try {
#if STEELKEEP_POLICY_REFUSAL_PROBE
        // Compile-only negative proof artifact; never enabled by a request or production configuration.
        throw new PolicyRefusal("compile_probe");
#endif
        ApplicationDataPlan.VerifySchemaOwners(context.Source);""")
source = source.replace(denial, '"database_security", "modifier_validation", "compile_probe" }.Contains(denial.Reason)')
with pathlib.Path(sys.argv[2]).open("x") as output:
    output.write(source)
