#!/usr/bin/env nextflow
nextflow.enable.dsl = 2

include { DEMO                    } from './workflows/demo'
include { PIPELINE_INITIALISATION } from './subworkflows/local/utils'
include { PIPELINE_COMPLETION     } from './subworkflows/local/utils'

workflow NFCORE_DEMO {
    take:
    samplesheet
    main:
    DEMO ( samplesheet )
}

workflow {
    PIPELINE_INITIALISATION ( params.input )
    NFCORE_DEMO ( PIPELINE_INITIALISATION.out.samplesheet )
    PIPELINE_COMPLETION ( )
}
