process BOWTIE2_ALIGN {
    tag "$meta.id"
    label 'process_medium'
    container "${ workflow.containerEngine == 'singularity' ? 'https://depot.galaxyproject.org/singularity/bowtie2:2.5.2--py39h6fed5c7_0' : 'biocontainers/bowtie2:2.5.2--py39h6fed5c7_0' }"

    input:
    tuple val(meta), path(reads)

    output:
    tuple val(meta), path("*.bam"), emit: bam
    tuple val(meta), path("*.log"), emit: log
    path "versions.yml", emit: versions

    script:
    """
    echo "process { } // not code" > versions.yml
    """
}
