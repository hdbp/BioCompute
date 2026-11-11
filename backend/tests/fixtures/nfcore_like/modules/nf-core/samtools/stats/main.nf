process SAMTOOLS_STATS {
    tag "$meta.id"
    label 'process_medium'
    container "${ workflow.containerEngine == 'singularity' ? 'https://depot.galaxyproject.org/singularity/samtools:1.19.2--h50ea8bc_0' : 'biocontainers/samtools:1.19.2--h50ea8bc_0' }"

    input:
    tuple val(meta), path(reads)

    output:
    tuple val(meta), path("*.stats"), emit: stats
    path "versions.yml", emit: versions

    script:
    """
    echo "process { } // not code" > versions.yml
    """
}
