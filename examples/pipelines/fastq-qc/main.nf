#!/usr/bin/env nextflow
/*
 * BioCompute FASTQ QC - a small, portable, nf-core-style DSL2 pipeline.
 * Requires only bash, awk, gzip and python3 (no containers), so it runs on any
 * Linux/macOS worker. Used as the reference end-to-end pipeline for BioCompute.
 */
nextflow.enable.dsl = 2

process FASTQ_STATS {
    tag "${meta.id}"
    cpus 1
    memory '1 GB'
    publishDir "${params.outdir}/fastq_stats", mode: 'copy'

    input:
    tuple val(meta), path(reads)

    output:
    tuple val(meta), path("${meta.id}.stats.tsv"), emit: stats
    tuple val(meta), path("${meta.id}.reads.tsv"), emit: reads

    script:
    """
    fastq_stats.sh '${meta.id}' ${params.min_read_length} ${params.min_mean_quality} ${params.max_reads} ${reads}
    """
}

process QC_REPORT {
    tag "report"
    cpus 1
    memory '1 GB'
    publishDir "${params.outdir}/report", mode: 'copy'

    input:
    path(stats, stageAs: 'stats/*')
    path(reads, stageAs: 'reads/*')
    path(samplesheet)

    output:
    path "qc_report.html", emit: html
    path "qc_summary.tsv", emit: summary

    script:
    """
    qc_report.py --title '${params.report_title}' --samplesheet ${samplesheet} --stats ${stats} --reads ${reads}
    """
}

workflow {
    if (!params.input) { error "Please provide a samplesheet with --input" }
    ch_samples = Channel.fromPath(params.input, checkIfExists: true)
        .splitCsv(header: true)
        .map { row ->
            def meta = [id: row.sample, condition: row.condition ?: '', replicate: row.replicate ?: '']
            def reads = row.fastq_2 ? [file(row.fastq_1, checkIfExists: true), file(row.fastq_2, checkIfExists: true)]
                                    : [file(row.fastq_1, checkIfExists: true)]
            [ meta, reads ]
        }
        .groupTuple()                                         // several rows (lanes) of one sample
        .map { meta, reads -> [ meta, reads.flatten() ] }     // -> one task over all of its files

    FASTQ_STATS(ch_samples)
    QC_REPORT(
        FASTQ_STATS.out.stats.map { it[1] }.collect(),
        FASTQ_STATS.out.reads.map { it[1] }.collect(),
        file(params.input)
    )
}

workflow.onComplete {
    log.info "BioCompute FASTQ QC finished: ${workflow.success ? 'OK' : 'FAILED'} - results in ${params.outdir}"
}
