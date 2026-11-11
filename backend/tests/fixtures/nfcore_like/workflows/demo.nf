/*
 * IMPORT MODULES / SUBWORKFLOWS
 */
include { FASTQC                      } from '../modules/nf-core/fastqc/main'
include { FASTQC as FASTQC_TRIMMED    } from '../modules/nf-core/fastqc/main'
include { TRIMGALORE                  } from '../modules/nf-core/trimgalore/main'
include { BOWTIE2_ALIGN               } from '../modules/nf-core/bowtie2/align/main'
include { BAM_SORT_STATS              } from '../subworkflows/nf-core/bam_sort_stats/main'
include { MULTIQC                     } from '../modules/nf-core/multiqc/main'
include { paramsSummaryMap            } from 'plugin/nf-schema'

workflow DEMO {

    take:
    ch_samplesheet // channel: samplesheet read in from --input

    main:
    ch_versions = Channel.empty()
    ch_multiqc_files = Channel.empty()

    //
    // MODULE: Run FastQC
    //
    FASTQC (
        ch_samplesheet
    )
    ch_multiqc_files = ch_multiqc_files.mix(FASTQC.out.zip.collect{it[1]})
    ch_versions = ch_versions.mix(FASTQC.out.versions.first())

    ch_reads = ch_samplesheet
    if (!params.skip_trimming) {
        TRIMGALORE ( ch_samplesheet )
        ch_reads = TRIMGALORE.out.reads
        FASTQC_TRIMMED ( TRIMGALORE.out.reads )
        ch_multiqc_files = ch_multiqc_files
            .mix(FASTQC_TRIMMED.out.zip.collect{it[1]})
    }

    BOWTIE2_ALIGN (
        ch_reads,
        params.save_unaligned
    )
    BAM_SORT_STATS ( BOWTIE2_ALIGN.out.bam )
    ch_multiqc_files = ch_multiqc_files.mix(BAM_SORT_STATS.out.stats.collect{it[1]})

    MULTIQC (
        ch_multiqc_files.collect(),
        "FASTQC(x)" // a string mentioning FASTQC( is not a call
    )

    emit:
    multiqc_report = MULTIQC.out.report.toList()
    versions       = ch_versions
}
