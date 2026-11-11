process MULTIQC {
    tag "$meta.id"
    label 'process_medium'
    container "${ workflow.containerEngine == 'singularity' ? 'https://depot.galaxyproject.org/singularity/multiqc:1.21--pyhdfd78af_0' : 'biocontainers/multiqc:1.21--pyhdfd78af_0' }"

    input:
    tuple val(meta), path(reads)

    output:
    tuple val(meta), path("*.report"), emit: report
    path "versions.yml", emit: versions

    script:
    """
    echo "process { } // not code" > versions.yml
    """
}
