<?php
/**
 * Fallback for anything without a template of its own (archives, search).
 * The site has no blog, so this points people back to what exists.
 */

defined( 'ABSPATH' ) || exit;

get_header();
?>
<section class="page-hero">
	<div class="wrap section-head">
		<h1><?php echo is_search() ? 'Search' : esc_html( get_the_archive_title() ); ?></h1>
	</div>
</section>
<section class="section">
	<div class="wrap prose">
		<?php if ( have_posts() ) : ?>
			<ul class="plain-list">
				<?php while ( have_posts() ) : the_post(); ?>
					<li><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></li>
				<?php endwhile; ?>
			</ul>
		<?php else : ?>
			<p>Nothing here. Try the <a href="<?php echo esc_url( home_url( '/' ) ); ?>">home page</a> or <a href="<?php echo esc_url( home_url( '/pricing/' ) ); ?>">pricing</a>.</p>
		<?php endif; ?>
	</div>
</section>
<?php get_footer(); ?>
