process SAMTOOLS_STATS {
    tag "$meta.id"
    label 'process_medium'
    container "${ workflow.containerEngine == 'singularity' ? 'https://depot.galaxyproject.org/singularity/samtools:1.19.2--h50ea8bc_0' : 'biocontainers/samtools:1.19.2--h50ea8bc_0' }"

    input:
    tuple val(meta), path(bam)

    output:
    tuple val(meta), path("*.stats"), emit: stats
    path "versions.yml", emit: versions

    when:
    task.ext.when == null || task.ext.when

    script:
    def args = task.ext.args ?: ''
    def prefix = task.ext.prefix ?: "${meta.id}"
    """
    echo "stats ${args}" > ${prefix}.stats
    echo 'SAMTOOLS_STATS: tool 1.0' > versions.yml
    """
}
