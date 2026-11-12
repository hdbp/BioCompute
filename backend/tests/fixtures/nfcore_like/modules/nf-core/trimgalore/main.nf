process TRIMGALORE {
    tag "$meta.id"
    label 'process_medium'
    container "${ workflow.containerEngine == 'singularity' ? 'https://depot.galaxyproject.org/singularity/trim-galore:0.6.7--hdfd78af_0' : 'biocontainers/trim-galore:0.6.7--hdfd78af_0' }"

    input:
    tuple val(meta), path(reads)

    output:
    tuple val(meta), path("*.trimmed.fq"), emit: reads
    tuple val(meta), path("*.log")       , emit: log
    path "versions.yml", emit: versions

    when:
    task.ext.when == null || task.ext.when

    script:
    def args = task.ext.args ?: ''
    def prefix = task.ext.prefix ?: "${meta.id}"
    """
    echo "trim_galore ${args}" > ${prefix}.log
    cat ${reads} > ${prefix}.trimmed.fq
    echo 'TRIMGALORE: tool 1.0' > versions.yml
    """
}
