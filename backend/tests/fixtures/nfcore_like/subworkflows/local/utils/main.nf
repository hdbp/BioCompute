workflow PIPELINE_INITIALISATION {
    take:
    input
    main:
    Channel.fromPath(input).splitCsv(header: true).map { row -> [[id: row.sample], file(row.fastq_1)] }.set { ch_samplesheet }
    emit:
    samplesheet = ch_samplesheet
}
workflow PIPELINE_COMPLETION {
    main:
    log.info "done"
}
