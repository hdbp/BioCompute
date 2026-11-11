workflow PIPELINE_INITIALISATION {
    take:
    input
    main:
    Channel.fromPath(input).splitCsv(header: true).set { ch_samplesheet }
    emit:
    samplesheet = ch_samplesheet
}
workflow PIPELINE_COMPLETION {
    main:
    log.info "done"
}
