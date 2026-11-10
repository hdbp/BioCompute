# Pipeline Studio

Studio builds workflows from a palette of modules and compiles them into a pipeline folder containing:

* `main.nf`, a Nextflow DSL2 script with one process per module;
* `nextflow.config`, holding the params, the docker/apptainer/singularity/conda profiles and the manifest;
* `nextflow_schema.json`, a 2020-12 nf-schema: one group per module, plus reference files and I/O. The generated pipeline therefore gets a schema-driven form automatically;
* `assets/schema_input.json`, the samplesheet schema;
* `bcflow.json`, so the same graph runs on the BioCompute native engine;
* `bin/bc_<process>.{sh,py,R}`, the module scripts. Both engines execute these identical scripts.

*Publish* writes the folder to the managed pipeline store and registers it, adding a new version
each time you publish. *Export* downloads it as a zip.

## Supported graph subset

| Construct | Support |
|---|---|
| Samplesheet source: per-sample FASTQ reads | One per graph. Several rows of one sample are merged (`BC_MERGE_LANES`) |
| Parameter-file source (genome, index, GTF…) | Any number; becomes a required path parameter and a value channel |
| Per-sample module | One task per sample. Several per-sample inputs are joined on sample ID |
| Aggregate module | One task over all samples. Inputs are flattened and collected; `multiple` ports mix several branches |
| Aggregate output into a per-sample module | Broadcast as a value channel to every sample |
| Branches (fan-out) | Unrestricted |
| Cycles, conditional logic, `when:` clauses, channel operators beyond the above | Not supported |
| Importing an existing `.nf` file into a graph | Not supported. Arbitrary Nextflow cannot be round-tripped faithfully |

Validation rejects anything outside this subset before code is generated.

## Module contract

A module script reads everything from environment variables:

| Variable | Meaning |
|---|---|
| `BC_PREFIX` | Sample ID, or the module name for aggregate modules |
| `BC_CPUS` | CPUs granted to the task |
| `BC_IN_<PORT>` | Space-separated input paths |
| `BC_PARAM_<NAME>` | Parameter values |

Outputs are files matching the declared pattern; `{prefix}` expands to the sample ID. Custom bash,
Python and R modules use the same contract. Admins can disable custom code with
`BIOCOMPUTE_ALLOW_CUSTOM_CODE_MODULES=false`.

Bioinformatics modules declare a biocontainers image and a conda package. Run with `-profile apptainer`,
`docker` or `conda` to get the tools, or have them on PATH. Under the native engine, tools must be on PATH.
