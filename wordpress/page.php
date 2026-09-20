<?php
/**
 * Plain pages: legal, support, anything written in the editor.
 */

defined( 'ABSPATH' ) || exit;

get_header();
while ( have_posts() ) :
	the_post();
	?>
	<section class="page-hero">
		<div class="wrap section-head">
			<h1><?php the_title(); ?></h1>
			<?php if ( has_excerpt() ) : ?><p class="lede"><?php echo esc_html( get_the_excerpt() ); ?></p><?php endif; ?>
		</div>
	</section>
	<section class="section">
		<div class="wrap prose-grid">
			<article class="prose">
				<?php the_content(); ?>
			</article>
			<aside class="prose-aside">
				<h4>Need a hand?</h4>
				<p>Write to <a href="mailto:<?php echo esc_attr( FORGE_SUPPORT_EMAIL ); ?>"><?php echo esc_html( FORGE_SUPPORT_EMAIL ); ?></a>. Include the address of the site if it is about a build.</p>
				<a class="button button-ghost" href="<?php echo esc_url( home_url( '/app/' ) ); ?>" data-member-text="Open Forge">Open Forge</a>
			</aside>
		</div>
	</section>
	<?php
endwhile;
get_footer();
