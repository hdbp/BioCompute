process MULTIQC {
    label 'process_single'
    container "${ workflow.containerEngine == 'singularity' ? 'https://depot.galaxyproject.org/singularity/multiqc:1.21--pyhdfd78af_0' : 'biocontainers/multiqc:1.21--pyhdfd78af_0' }"

    input:
    path multiqc_files, stageAs: "?/*"
    val title

    output:
    path "*.html"      , emit: report
    path "versions.yml", emit: versions

    when:
    task.ext.when == null || task.ext.when

    script:
    def args = task.ext.args ?: ''
    """
    ls -R > multiqc_report.html
    echo "multiqc ${args}" >> multiqc_report.html
    echo 'MULTIQC: tool 1.0' > versions.yml
    """
}
