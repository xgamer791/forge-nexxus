<!doctype html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo( 'charset' ); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<?php if ( is_front_page() ) : ?>
<script>
// A member landing on the home page is sent straight into the builder, the
// way chat products open the app for a signed-in visitor. The token in
// storage only decides where to go; the builder itself still asks the server
// who is signed in before it shows anything.
(function(){try{if(location.search.indexOf('home')===-1&&localStorage.getItem('forge-auth-kind')==='member'&&localStorage.getItem('forge-auth-token')){location.replace(<?php echo wp_json_encode( home_url( '/app/' ) ); ?>);}}catch(e){}})();
</script>
<?php endif; ?>
<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header" data-header>
	<div class="wrap header-inner">
		<a class="brand" href="<?php echo esc_url( home_url( '/' ) ); ?>" aria-label="Forge Nexxus home">
			<?php echo forge_mark( 'brand-mark' ); ?>
			<span>Forge Nexxus</span>
		</a>
		<nav class="site-nav" aria-label="Primary" id="site-nav">
			<?php forge_primary_menu(); ?>
		</nav>
		<div class="header-actions">
			<a class="button button-ghost header-signin" href="<?php echo esc_url( home_url( '/app/' ) ); ?>" data-member-hide>Sign in</a>
			<a class="button" href="<?php echo esc_url( home_url( '/app/' ) ); ?>" data-member-text="Open Forge">Start building</a>
			<button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" aria-label="Menu" data-nav-toggle>
				<span></span><span></span>
			</button>
		</div>
	</div>
</header>
<main id="main" class="site-main">
