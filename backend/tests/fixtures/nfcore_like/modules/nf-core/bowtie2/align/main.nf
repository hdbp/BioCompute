process BOWTIE2_ALIGN {
    tag "$meta.id"
    label 'process_medium'
    container "${ workflow.containerEngine == 'singularity' ? 'https://depot.galaxyproject.org/singularity/bowtie2:2.5.2--py39h6fed5c7_0' : 'biocontainers/bowtie2:2.5.2--py39h6fed5c7_0' }"

    input:
    tuple val(meta), path(reads)
    val save_unaligned

    output:
    tuple val(meta), path("*.bam"), emit: bam
    tuple val(meta), path("*.log"), emit: log
    path "versions.yml", emit: versions

    when:
    task.ext.when == null || task.ext.when

    script:
    def args = task.ext.args ?: ''
    def prefix = task.ext.prefix ?: "${meta.id}"
    """
    echo "bowtie2 ${args}" > ${prefix}.log
    cat ${reads} > ${prefix}.bam
    echo 'BOWTIE2_ALIGN: tool 1.0' > versions.yml
    """
}
