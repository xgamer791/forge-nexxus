<?php
defined( 'ABSPATH' ) || exit;
get_header();
?>
<section class="page-hero">
	<div class="wrap section-head">
		<h1>That page was never built.</h1>
		<p class="lede">The address may have changed, or the link was wrong. Everything Forge has is one click away.</p>
		<div class="button-row">
			<a class="button" href="<?php echo esc_url( home_url( '/' ) ); ?>">Home</a>
			<a class="button button-ghost" href="<?php echo esc_url( home_url( '/app/' ) ); ?>" data-member-text="Open Forge">Open Forge</a>
		</div>
	</div>
</section>
<?php get_footer(); ?>
