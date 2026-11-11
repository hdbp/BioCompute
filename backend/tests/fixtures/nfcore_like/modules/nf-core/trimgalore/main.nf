process TRIMGALORE {
    tag "$meta.id"
    label 'process_medium'
    container "${ workflow.containerEngine == 'singularity' ? 'https://depot.galaxyproject.org/singularity/trim-galore:0.6.7--hdfd78af_0' : 'biocontainers/trim-galore:0.6.7--hdfd78af_0' }"

    input:
    tuple val(meta), path(reads)

    output:
    tuple val(meta), path("*.reads"), emit: reads
    tuple val(meta), path("*.log"), emit: log
    path "versions.yml", emit: versions

    script:
    """
    echo "process { } // not code" > versions.yml
    """
}
