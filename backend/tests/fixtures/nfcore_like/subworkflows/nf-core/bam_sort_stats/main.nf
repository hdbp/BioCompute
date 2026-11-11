include { SAMTOOLS_SORT  } from '../../../modules/nf-core/samtools/sort/main'
include { SAMTOOLS_STATS } from '../../../modules/nf-core/samtools/stats/main'

workflow BAM_SORT_STATS {
    take:
    ch_bam // channel: [ val(meta), path(bam) ]

    main:
    SAMTOOLS_SORT ( ch_bam )
    SAMTOOLS_STATS ( SAMTOOLS_SORT.out.bam )

    emit:
    bam   = SAMTOOLS_SORT.out.bam
    stats = SAMTOOLS_STATS.out.stats
}
