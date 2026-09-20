<?php
/**
 * Forge Nexxus — the website client.
 *
 * Signed-out visitors get the marketing site (home, pricing, legal). Members
 * get the builder at /app/, which runs the same Convex-backed client as the
 * mobile app: same account, same sites, same credits, same settings.
 */

defined( 'ABSPATH' ) || exit;

/**
 * The cache buster covers every asset the theme enqueues, not just the
 * marketing stylesheet: the builder ships its own CSS and two scripts, and a
 * version pinned to one file serves the rest stale after a deploy.
 */
define(
	'FORGE_THEME_VERSION',
	wp_get_theme()->get( 'Version' ) . '.' . (string) max(
		array_map(
			static fn( $asset ) => (int) @filemtime( get_theme_file_path( $asset ) ),
			[
				'assets/css/site.css',
				'assets/css/app.css',
				'assets/css/auth.css',
				'assets/js/site.js',
				'assets/js/forge-app.js',
				'assets/js/forge-auth.js',
				'assets/js/forge-data.js',
				'assets/js/onboarding.js',
				'assets/video/forge-viking-loop.mp4',
				'assets/video/forge-viking-login.mp4',
				'assets/video/forge-viking-poster.jpg',
			]
		)
	)
);

require_once get_theme_file_path( 'inc/convex.php' );

const FORGE_FONTS_URL = 'https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@700,800&f[]=general-sans@400,500,600&display=swap';

add_action(
	'after_setup_theme',
	function () {
		add_theme_support( 'title-tag' );
		add_theme_support( 'html5', [ 'search-form', 'gallery', 'caption', 'style', 'script', 'navigation-widgets' ] );
		add_theme_support( 'post-thumbnails' );
		add_theme_support( 'responsive-embeds' );
		remove_theme_support( 'widgets-block-editor' );
		register_nav_menus(
			[
				'primary' => 'Primary (header)',
				'footer'  => 'Footer',
			]
		);
	}
);

/** Whether this request renders the builder rather than a marketing page. */
function forge_is_app(): bool {
	return is_page( 'app' );
}

add_action(
	'wp_enqueue_scripts',
	function () {
		wp_enqueue_style( 'forge-fonts', FORGE_FONTS_URL, [], null );
		if ( forge_is_app() ) {
			wp_enqueue_style( 'forge-app', get_theme_file_uri( 'assets/css/app.css' ), [ 'forge-fonts' ], FORGE_THEME_VERSION );
			wp_enqueue_style( 'forge-auth', get_theme_file_uri( 'assets/css/auth.css' ), [ 'forge-app' ], FORGE_THEME_VERSION );
			wp_enqueue_script( 'forge-data', get_theme_file_uri( 'assets/js/forge-data.js' ), [], FORGE_THEME_VERSION, [ 'in_footer' => true, 'strategy' => 'blocking' ] );
			wp_enqueue_script( 'forge-app', get_theme_file_uri( 'assets/js/forge-app.js' ), [ 'forge-data' ], FORGE_THEME_VERSION, [ 'in_footer' => true, 'strategy' => 'blocking' ] );
			wp_enqueue_script( 'forge-onboarding', get_theme_file_uri( 'assets/js/onboarding.js' ), [ 'forge-app' ], FORGE_THEME_VERSION, [ 'in_footer' => true, 'strategy' => 'blocking' ] );
			wp_enqueue_script( 'forge-auth-js', get_theme_file_uri( 'assets/js/forge-auth.js' ), [ 'forge-onboarding' ], FORGE_THEME_VERSION, [ 'in_footer' => true, 'strategy' => 'blocking' ] );
			return;
		}
		wp_enqueue_style( 'forge-site', get_theme_file_uri( 'assets/css/site.css' ), [ 'forge-fonts' ], FORGE_THEME_VERSION );
		wp_enqueue_script( 'forge-site', get_theme_file_uri( 'assets/js/site.js' ), [], FORGE_THEME_VERSION, [ 'in_footer' => true, 'strategy' => 'defer' ] );
		wp_localize_script(
			'forge-site',
			'ForgeSite',
			[
				'appUrl'    => home_url( '/app/' ),
				'mobileUrl' => FORGE_MOBILE_APP_URL,
			]
		);
	}
);

// The builder page is a self-contained document; nothing from WordPress'
// front-end stack belongs in it, and neither do plugin styles.
add_action(
	'wp_enqueue_scripts',
	function () {
		if ( ! forge_is_app() ) {
			return;
		}
		foreach ( [ 'wp-block-library', 'wp-block-library-theme', 'global-styles', 'classic-theme-styles', 'breeze-styles' ] as $handle ) {
			wp_dequeue_style( $handle );
		}
	},
	100
);

// Block-editor and emoji baggage is not needed on a hand-built theme.
add_action(
	'init',
	function () {
		remove_action( 'wp_head', 'print_emoji_detection_script', 7 );
		remove_action( 'wp_print_styles', 'print_emoji_styles' );
		remove_action( 'wp_head', 'wp_generator' );
		remove_action( 'wp_head', 'wlwmanifest_link' );
		remove_action( 'wp_head', 'rsd_link' );
		remove_action( 'wp_head', 'wp_shortlink_wp_head' );
		remove_action( 'wp_head', 'feed_links_extra', 3 );
	}
);
add_action( 'wp_enqueue_scripts', fn() => wp_dequeue_style( 'global-styles' ), 20 );
add_filter( 'should_load_separate_core_block_assets', '__return_true' );

// The builder is an application view: keep it out of search results and
// send the mobile app's OAuth/magic-link return path through untouched.
add_filter(
	'wp_robots',
	function ( array $robots ) {
		if ( forge_is_app() ) {
			$robots['noindex']  = true;
			$robots['nofollow'] = true;
		}
		return $robots;
	}
);
add_filter(
	'redirect_canonical',
	function ( $redirect_url ) {
		return forge_is_app() ? false : $redirect_url;
	}
);

add_filter(
	'body_class',
	function ( array $classes ) {
		$classes[] = forge_is_app() ? 'forge-app-body' : 'forge-site-body';
		if ( is_front_page() ) {
			$classes[] = 'is-home';
		}
		return $classes;
	}
);

/** Social and description meta for the marketing pages. */
add_action(
	'wp_head',
	function () {
		if ( forge_is_app() ) {
			return;
		}
		$description = is_front_page()
			? 'Describe the website you want and Forge Nexxus builds it. One account across the mobile app and the web: your sites, credits and settings follow you.'
			: ( is_singular() ? wp_strip_all_tags( get_the_excerpt() ) : get_bloginfo( 'description' ) );
		$image = get_theme_file_uri( 'assets/img/og-banner.jpg' );
		$title = wp_get_document_title();
		$url   = is_front_page() ? home_url( '/' ) : get_permalink();
		echo '<meta name="description" content="' . esc_attr( $description ) . '">' . "\n";
		echo '<meta property="og:site_name" content="Forge Nexxus">' . "\n";
		echo '<meta property="og:type" content="website">' . "\n";
		echo '<meta property="og:title" content="' . esc_attr( $title ) . '">' . "\n";
		echo '<meta property="og:description" content="' . esc_attr( $description ) . '">' . "\n";
		echo '<meta property="og:url" content="' . esc_url( $url ) . '">' . "\n";
		echo '<meta property="og:image" content="' . esc_url( $image ) . '">' . "\n";
		echo '<meta name="twitter:card" content="summary_large_image">' . "\n";
		echo '<meta name="theme-color" content="#ffffff">' . "\n";
		echo '<link rel="preconnect" href="https://api.fontshare.com" crossorigin>' . "\n";
		echo '<link rel="preconnect" href="https://cdn.fontshare.com" crossorigin>' . "\n";
	},
	1
);

add_filter(
	'document_title_separator',
	fn() => '·'
);

/** Menu fallbacks so the header and footer read right before menus exist. */
function forge_primary_menu(): void {
	if ( has_nav_menu( 'primary' ) ) {
		wp_nav_menu(
			[
				'theme_location' => 'primary',
				'container'      => false,
				'menu_class'     => 'nav-list',
				'depth'          => 1,
			]
		);
		return;
	}
	?>
	<ul class="nav-list">
		<li><a href="<?php echo esc_url( home_url( '/#showcase' ) ); ?>">Showcase</a></li>
		<li><a href="<?php echo esc_url( home_url( '/#how' ) ); ?>">How it works</a></li>
		<li><a href="<?php echo esc_url( home_url( '/pricing/' ) ); ?>">Pricing</a></li>
	</ul>
	<?php
}

function forge_footer_menu(): void {
	if ( has_nav_menu( 'footer' ) ) {
		wp_nav_menu(
			[
				'theme_location' => 'footer',
				'container'      => false,
				'menu_class'     => 'footer-list',
				'depth'          => 1,
			]
		);
		return;
	}
	?>
	<ul class="footer-list">
		<li><a href="<?php echo esc_url( home_url( '/privacy/' ) ); ?>">Privacy</a></li>
		<li><a href="<?php echo esc_url( home_url( '/terms/' ) ); ?>">Terms</a></li>
		<li><a href="<?php echo esc_url( home_url( '/support/' ) ); ?>">Support</a></li>
	</ul>
	<?php
}

/** The inline mark used in the header, footer and the builder. */
function forge_mark( string $class = 'mark' ): string {
	return '<svg class="' . esc_attr( $class ) . '" viewBox="0 0 24 30" aria-hidden="true"><path fill="currentColor" d="m12 0 5 5-3 3 10 7-6 15H6L0 15l10-7-3-3Z"/></svg>';
}

/** A theme image URL. */
function forge_img( string $file ): string {
	return get_theme_file_uri( 'assets/img/' . $file );
}


/**
 * Old bookmarks and auth return URLs that pointed at legacy paths
 * should still land in the builder.
 */
add_action( 'template_redirect', function () {
	if ( is_admin() || wp_doing_ajax() || wp_doing_cron() ) {
		return;
	}
	$path = trim( (string) parse_url( $_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH ), '/' );
	$legacy = array( 'login', 'signin', 'sign-in', 'signup', 'sign-up', 'register', 'dashboard' );
	if ( in_array( strtolower( $path ), $legacy, true ) ) {
		wp_safe_redirect( home_url( '/app/' ), 302 );
		exit;
	}
}, 0 );
